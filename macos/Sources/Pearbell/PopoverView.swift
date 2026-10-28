import AppKit
import SwiftUI

// The popover under the menu bar icon: the phone app's inbox, Mac sized.
struct PopoverView: View {
  @EnvironmentObject var model: AppModel
  @State private var showSettings = false
  @State private var showArchive = false
  @State private var showTopics = false

  // The ask bar shows under the inbox while it shows one topic.
  private var asking: Bool {
    !showSettings && !showArchive && !showTopics && model.focused == nil && model.topic != nil
  }

  var body: some View {
    VStack(spacing: 0) {
      if showSettings {
        SettingsView(close: { showSettings = false })
      } else if let id = model.focused, let message = model.messages.first(where: { $0.id == id }) {
        MessageDetail(message: message)
      } else if showTopics {
        TopicsView(canAsk: !showArchive, close: { showTopics = false })
      } else if showArchive {
        ArchiveView(close: { showArchive = false }, showTopics: { showTopics = true })
      } else {
        header
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            if model.link == .offline || model.link == .outdated {
              DaemonCard()
                .padding(.top, 8)
            }
            if model.waiting.isEmpty && model.recent.isEmpty {
              EmptyInbox()
            } else {
              if !model.shownWaiting.isEmpty {
                SectionTitle(text: "Waiting for you", count: model.shownWaiting.count)
                ForEach(model.shownWaiting) { message in
                  QuestionCard(message: message, shortcuts: message.id == model.shownWaiting.first?.id)
                    .padding(.bottom, 12)
                }
              }
              if !model.shownRecent.isEmpty {
                HStack {
                  SectionTitle(text: "Recent")
                  Spacer()
                  Button("Clear") { model.clearRecent() }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.primary)
                    .padding(.top, 8)
                }
                VStack(spacing: 2) {
                  ForEach(model.shownRecent) { message in
                    MessageRow(message: message)
                  }
                }
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
              }
            }
          }
          .padding(.horizontal, 16)
          .padding(.bottom, 16)
        }
        if let topic = model.topic {
          AskBar(topic: topic)
        }
      }
    }
    .frame(width: 380, height: 580)
    .overlay(alignment: .bottom) { NoticeBar().padding(.bottom, asking ? 96 : 0) }
    .animation(.easeOut(duration: 0.2), value: model.notice)
    .background(Palette.background)
    .foregroundStyle(Palette.onSurface)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Inbox")
          .font(.system(size: 28, weight: .semibold))
          .tracking(-0.5)
        Spacer()
        SnoozeMenu()
        IconButton(symbol: "archivebox", label: "Archive") { showArchive = true }
        IconButton(symbol: "gearshape", label: "Settings") { showSettings = true }
      }
      StatusPill()
      RouteLine()
      TopicChips(onMore: { showTopics = true })
    }
    .padding(.horizontal, 20)
    .padding(.top, 16)
    .padding(.bottom, 4)
  }
}

struct IconButton: View {
  let symbol: String
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .medium))
        .frame(width: 32, height: 32)
        .background(Circle().fill(Palette.surfaceContainer))
    }
    .buttonStyle(.plain)
    .help(label)
    .accessibilityLabel(label)
  }
}

// "Connected to Pixel 8", like the phone's "Connected to <computer>".
struct StatusPill: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    HStack(spacing: 8) {
      StatusDot(online: model.link == .connected && !model.onlinePhones.isEmpty)
      Text(text)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Palette.onSurfaceVariant)
        .lineLimit(1)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(Capsule().fill(Palette.surfaceContainer))
  }

  private var text: String {
    if model.link == .outdated { return "The pearbell daemon needs an update" }
    if model.link != .connected { return "The pearbell daemon is not running" }
    if model.devices.isEmpty { return "No phone paired. Run: pearbell pair" }
    let online = model.onlinePhones.map(\.name)
    if online.isEmpty { return "\(model.devices.map(\.name).joined(separator: ", ")) offline" }
    return "Connected to \(online.joined(separator: ", "))"
  }
}

// Where the next message goes, and why.
struct RouteLine: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    if model.link == .connected && !model.devices.isEmpty {
      HStack(spacing: 6) {
        Image(systemName: model.away == nil ? "desktopcomputer" : "iphone")
          .font(.system(size: 11, weight: .medium))
        Text(model.away.map { "New messages go to your phone: \($0)" } ?? "New messages show up on this Mac while you are here")
          .font(.system(size: 11))
          .lineLimit(2)
      }
      .foregroundStyle(Palette.onSurfaceVariant)
      .padding(.leading, 4)
    }
  }
}

struct SectionTitle: View {
  let text: String
  var count: Int?

  var body: some View {
    HStack(spacing: 8) {
      Text(text)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Palette.onSurfaceVariant)
      if let count {
        Text("\(count)")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Palette.onPrimary)
          .padding(.horizontal, 7)
          .padding(.vertical, 1)
          .background(Capsule().fill(Palette.primary))
      }
    }
    .padding(.leading, 4)
    .padding(.top, 18)
    .padding(.bottom, 10)
  }
}

// An open question: the green card with quick replies and a reply field.
struct QuestionCard: View {
  @EnvironmentObject var model: AppModel
  let message: Message
  // ⌘1…⌘3 pick its quick replies; only one card on screen gets them.
  var shortcuts = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        Avatar(name: message.sender, size: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text(message.sender)
            .font(.system(size: 14, weight: .semibold))
            .lineLimit(1)
          Text(subtitle(message))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Palette.onSurfaceVariant)
            .lineLimit(1)
        }
      }
      .contentShape(Rectangle())
      .onTapGesture { model.focused = message.id }
      .help("Open the message")

      MarkdownText(text: message.body, size: 15, selectable: true)
        .padding(.top, 12)

      QuestionReplies(message: message, shortcuts: shortcuts)
    }
    .padding(16)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(Palette.primaryContainer.opacity(0.45))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(Palette.primary.opacity(0.35), lineWidth: 1)
    )
  }
}

// The quick replies and the reply field of an open question.
struct QuestionReplies: View {
  @EnvironmentObject var model: AppModel
  let message: Message
  var shortcuts = false
  @State private var draft = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !message.actions.isEmpty {
        HStack(spacing: 8) {
          ForEach(Array(message.actions.enumerated()), id: \.offset) { i, label in
            Button(label) { model.answer(message.id, label) }
              .buttonStyle(PillButtonStyle(filled: i == 0))
              .shortcut(shortcuts && i < 3 ? KeyEquivalent(Character("\(i + 1)")) : nil)
              .help(shortcuts && i < 3 ? "⌘\(i + 1)" : label)
          }
        }
        .padding(.top, 14)
      }

      HStack(spacing: 8) {
        TextField("Write a reply…", text: $draft)
          .textFieldStyle(.plain)
          .font(.system(size: 13))
          .onSubmit(send)
        Button(action: send) {
          Image(systemName: "paperplane.fill")
            .foregroundStyle(draft.trimmingCharacters(in: .whitespaces).isEmpty ? Palette.outline : Palette.primary)
        }
        .buttonStyle(.plain)
        .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
        .accessibilityLabel("Send reply")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .background(Capsule().fill(Palette.surfaceLowest))
      .padding(.top, 12)
    }
    .disabled(model.link != .connected)
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    model.answer(message.id, text)
    draft = ""
  }
}

// A message in the Recent list.
struct MessageRow: View {
  @EnvironmentObject var model: AppModel
  let message: Message
  @State private var offset: CGFloat = 0

  // Drag left to archive (or back to the inbox), right to delete, like the phone.
  private var swipe: some Gesture {
    DragGesture(minimumDistance: 12)
      .onChanged { value in
        if abs(value.translation.width) > abs(value.translation.height) { offset = value.translation.width }
      }
      .onEnded { _ in
        let done = offset
        withAnimation(.easeOut(duration: 0.15)) { offset = 0 }
        if done < -90 { model.archive(message.id, !message.archived) }
        if done > 90 { model.delete(message.id) }
      }
  }

  var body: some View {
    content
    .offset(x: offset)
    .background(SwipeBackground(offset: offset, archived: message.archived))
    .clipped()
    .gesture(swipe)
    .contextMenu {
      Button("Copy text") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.body, forType: .string)
      }
      Button(message.archived ? "Move to the inbox" : "Archive") { model.archive(message.id, !message.archived) }
      Button("Delete", role: .destructive) { model.delete(message.id) }
    }
  }

  @ViewBuilder
  private var content: some View {
    if message.mine { mine } else { received }
  }

  // Something you wrote to a topic: on the right, in the accent color.
  private var mine: some View {
    let status = heardStatus(message, connected: model.link == .connected)
    return VStack(alignment: .trailing, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("You")
          .font(.system(size: 13, weight: .semibold))
        TopicTag(topic: message.topic)
        Text(messageTime(message))
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Palette.onSurfaceVariant)
      }
      Text(message.body)
        .font(.system(size: 13))
        .multilineTextAlignment(.trailing)
        .lineLimit(3)
      Label(status.text, systemImage: status.heard ? "checkmark" : "ellipsis")
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(status.heard ? Palette.primary : Palette.outline)
        .padding(.top, 3)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .trailing)
    .background(Palette.primaryContainer)
    .contentShape(Rectangle())
    .onTapGesture { model.focused = message.id }
  }

  private var received: some View {
    HStack(alignment: .top, spacing: 12) {
      Avatar(name: message.sender, size: 36)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(message.sender)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1)
          if !message.topic.isEmpty { TopicTag(topic: message.topic) }
          Spacer()
          Text(messageTime(message))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(message.updatedAt == nil ? Palette.onSurfaceVariant : Palette.primary)
        }
        Text(plainText(message.body))
          .font(.system(size: 13))
          .foregroundStyle(Palette.onSurfaceVariant)
          .lineLimit(3)
        if let answer = message.answer {
          Label(message.answeredBy.map { "Answered on \($0): “\(answer)”" } ?? "You replied “\(answer)”", systemImage: "checkmark")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Palette.primary)
            .padding(.top, 4)
        } else if message.wantsReply && message.closed {
          Text("No longer waiting")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Palette.outline)
            .padding(.top, 4)
        }
        if message.route == "phone" {
          Label("Sent to your phone: \(message.reason)", systemImage: "iphone")
            .font(.system(size: 11))
            .foregroundStyle(Palette.outline)
            .padding(.top, 2)
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surfaceLow)
    .contentShape(Rectangle())
    .onTapGesture { model.focused = message.id }
  }
}

// When the daemon is not running there is nothing to show.
struct DaemonCard: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "bolt.fill")
        .foregroundStyle(Palette.tertiary)
      VStack(alignment: .leading, spacing: 4) {
        if model.link == .outdated {
          Text("Update the pearbell CLI")
            .font(.system(size: 13, weight: .semibold))
          Text("The daemon running now is from a pearbell version without the menu bar app. Update it with npm install -g pearbell@latest, then run pearbell stop to restart it.")
            .font(.system(size: 12))
            .fixedSize(horizontal: false, vertical: true)
        } else {
          Text("Start the daemon")
            .font(.system(size: 13, weight: .semibold))
          Text(model.startError ?? "Messages reach this Mac through the pearbell daemon. To keep it running from login on, run: pearbell service install")
            .font(.system(size: 12))
            .fixedSize(horizontal: false, vertical: true)
          Button("Start it now") { model.startDaemon() }
            .buttonStyle(PillButtonStyle(filled: false))
            .padding(.top, 6)
        }
      }
    }
    .foregroundStyle(Palette.onTertiaryContainer)
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Palette.tertiaryContainer))
  }
}

struct EmptyInbox: View {
  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        Circle().fill(Palette.primary.opacity(0.06)).frame(width: 136, height: 136)
        Circle().fill(Palette.primary.opacity(0.10)).frame(width: 100, height: 100)
        Circle().fill(Palette.primary).frame(width: 68, height: 68)
        Image(systemName: "bell.fill")
          .font(.system(size: 28))
          .foregroundStyle(Palette.onPrimary)
      }
      Text("All quiet")
        .font(.system(size: 22, weight: .semibold))
        .padding(.top, 22)
      Text("Messages from your terminal show up here while you are at your Mac, and on your phone when you step away. Send yourself one:")
        .font(.system(size: 13))
        .foregroundStyle(Palette.onSurfaceVariant)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 8)
      Text("pearbell send \"hello\"")
        .font(.system(size: 12, design: .monospaced))
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Palette.surfaceContainer))
        .padding(.top, 16)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 48)
    .padding(.horizontal, 16)
  }
}

func subtitle(_ message: Message) -> String {
  let when = messageTime(message)
  switch message.route {
  case "both": return "\(when) · also on your phone"
  case "phone": return "\(when) · sent to your phone"
  default: return when
  }
}

// When it came, or when an update last changed it: "updated 4 min".
func messageTime(_ message: Message) -> String {
  message.updatedAt.map { "updated \(ago($0))" } ?? ago(message.receivedAt)
}

func ago(_ date: Date) -> String {
  let seconds = Date().timeIntervalSince(date)
  if seconds < 60 { return "now" }
  if seconds < 3600 { return "\(Int(seconds / 60)) min" }
  if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
  return date.formatted(.dateTime.month(.abbreviated).day())
}

// One message, opened from its notification or the inbox, like the phone's
// message details.
struct MessageDetail: View {
  @EnvironmentObject var model: AppModel
  let message: Message

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        IconButton(symbol: "chevron.left", label: "Back to the inbox") { model.focused = nil }
          .keyboardShortcut(.cancelAction)
        Spacer()
        IconButton(symbol: message.archived ? "tray.and.arrow.up" : "archivebox", label: message.archived ? "Move to the inbox" : "Archive") {
          model.archive(message.id, !message.archived)
          model.focused = nil
        }
        IconButton(symbol: "trash", label: "Delete") { model.delete(message.id) }
        IconButton(symbol: "doc.on.doc", label: "Copy text") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(message.body, forType: .string)
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 16)
      .padding(.bottom, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 12) {
            Avatar(name: message.sender, size: 44)
            VStack(alignment: .leading, spacing: 4) {
              Text(message.sender)
                .font(.system(size: 18, weight: .semibold))
                .textSelection(.enabled)
              HStack(spacing: 6) {
                if !message.topic.isEmpty { TopicTag(topic: message.topic) }
                Text(message.receivedAt.formatted(date: .complete, time: .shortened))
                  .font(.system(size: 11, weight: .medium))
                  .foregroundStyle(Palette.onSurfaceVariant)
              }
              if let updated = message.updatedAt {
                Label(
                  "Updated \(updated.formatted(date: .omitted, time: .shortened))" + (message.updates > 1 ? " · \(message.updates) updates" : ""),
                  systemImage: "pencil"
                )
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Palette.primary)
              }
            }
          }

          if message.mine {
            let status = heardStatus(message, connected: model.link == .connected)
            Label("Written to a topic on this Mac · \(status.text)", systemImage: status.heard ? "checkmark" : "ellipsis")
              .font(.system(size: 11, weight: .medium))
              .foregroundStyle(status.heard ? Palette.primary : Palette.outline)
              .padding(.top, 10)
          }

          if message.route == "phone" || message.route == "both" {
            Label("Sent to your phone: \(message.reason)", systemImage: "iphone")
              .font(.system(size: 11))
              .foregroundStyle(Palette.outline)
              .padding(.top, 10)
          }

          MarkdownText(text: message.body, size: 14, selectable: true)
            .padding(.top, 16)

          if message.waiting {
            QuestionReplies(message: message, shortcuts: true)
              .padding(.top, 4)
          } else if let answer = message.answer {
            Label(message.answeredBy.map { "Answered on \($0): “\(answer)”" } ?? "You replied “\(answer)”", systemImage: "checkmark")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Palette.primary)
              .padding(.top, 14)
          } else if message.wantsReply && message.closed {
            Text("No longer waiting")
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(Palette.outline)
              .padding(.top, 14)
          }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}

// Send everything to the phone for a while, like a Do Not Disturb for the Mac.
struct SnoozeMenu: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    Menu {
      if let until = model.snoozedUntil {
        Text("Snoozed until \(until.formatted(date: .omitted, time: .shortened))")
        Button("Resume") { model.snooze(until: nil) }
        Divider()
      }
      Button("Send to phone for 1 hour") { model.snooze(until: Date().addingTimeInterval(3600)) }
      Button("Send to phone until tomorrow") { model.snooze(until: tomorrowMorning()) }
    } label: {
      Image(systemName: model.snoozedUntil == nil ? "moon" : "moon.fill")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(model.snoozedUntil == nil ? Palette.onSurface : Palette.primary)
        .frame(width: 32, height: 32)
        .background(Circle().fill(Palette.surfaceContainer))
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .help(model.snoozedUntil == nil ? "Snooze this Mac" : "Snoozed")
    .disabled(model.devices.isEmpty)
  }

  // 8:00 the next morning.
  private func tomorrowMorning() -> Date {
    let calendar = Calendar.current
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
  }
}

// "All", then as many topics as fit on one line, then a chip that opens the
// list of every topic (TopicsView), like the phone. The picked topic always
// shows, right after "All". Hidden when no message has a topic.
struct TopicChips: View {
  @EnvironmentObject var model: AppModel
  let onMore: () -> Void

  var body: some View {
    let topics = model.topics
    if !topics.isEmpty {
      let picked = topics.filter { $0.name == model.topic }
      let ordered = picked + topics.filter { $0.name != model.topic }
      // The longest row that fits wins, so the last chip says how many are left.
      ViewThatFits(in: .horizontal) {
        ForEach((0...ordered.count).reversed(), id: \.self) { shown in
          row(Array(ordered.prefix(shown)), hidden: ordered.count - shown)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 2)
    }
  }

  private func row(_ shown: [AppModel.TopicInfo], hidden: Int) -> some View {
    HStack(spacing: 8) {
      chip("All", count: model.messages.count, selected: model.topic == nil) { model.topic = nil }
      ForEach(shown, id: \.name) { topic in
        chip(topic.name, count: topic.count, selected: model.topic == topic.name) {
          model.topic = model.topic == topic.name ? nil : topic.name
        }
      }
      Button(action: onMore) {
        HStack(spacing: 5) {
          Image(systemName: "list.bullet").font(.system(size: 10, weight: .bold))
          Text(hidden > 0 ? "+\(hidden)" : "Topics").lineLimit(1)
        }
        .font(.system(size: 12, weight: .medium))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Capsule().fill(Palette.surfaceContainer))
      }
      .buttonStyle(.plain)
      .help("All topics")
    }
    .fixedSize()
  }

  private func chip(_ label: String, count: Int, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if selected {
          Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
        }
        Text(label).lineLimit(1).frame(maxWidth: 120)
        Text("\(count)").monospacedDigit().foregroundStyle(Palette.onSurfaceVariant)
      }
      .font(.system(size: 12, weight: .medium))
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(Capsule().fill(selected ? Palette.primaryContainer : Palette.surfaceContainer))
    }
    .buttonStyle(.plain)
  }
}

// Every topic with its message count and when its last message came. Click
// one to see only it; Ask (in the inbox) writes to whatever listens on it.
struct TopicsView: View {
  @EnvironmentObject var model: AppModel
  let canAsk: Bool
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        IconButton(symbol: "chevron.left", label: "Back", action: close)
          .keyboardShortcut(.cancelAction)
        Text("Topics")
          .font(.system(size: 22, weight: .semibold))
        Spacer()
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      .padding(.bottom, 8)

      ScrollView {
        VStack(spacing: 2) {
          TopicRow(name: "All messages", detail: count(model.messages.count), picked: model.topic == nil, onAsk: nil) {
            model.topic = nil
            close()
          }
          ForEach(model.topics, id: \.name) { topic in
            TopicRow(
              name: topic.name,
              detail: "\(count(topic.count)) · last \(lastTime(topic.lastAt))",
              picked: model.topic == topic.name,
              onAsk: canAsk ? {
                model.topic = topic.name
                model.askFocus += 1
                close()
              } : nil
            ) {
              model.topic = topic.name
              close()
            }
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
      }
    }
  }

  private func count(_ n: Int) -> String { n == 1 ? "1 message" : "\(n) messages" }

  private func lastTime(_ date: Date) -> String {
    Date().timeIntervalSince(date) < 60 ? "just now" : RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
  }
}

private struct TopicRow: View {
  let name: String
  let detail: String
  let picked: Bool
  let onAsk: (() -> Void)?
  let action: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(name)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(picked ? Palette.primary : Palette.onSurface)
          .lineLimit(1)
        Text(detail)
          .font(.system(size: 11))
          .foregroundStyle(Palette.onSurfaceVariant)
          .lineLimit(1)
      }
      Spacer()
      if picked {
        Image(systemName: "checkmark")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(Palette.primary)
          .accessibilityLabel("Showing")
      }
      if let onAsk {
        Button("Ask", action: onAsk)
          .buttonStyle(.plain)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Palette.primary)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .help("Ask \(name)")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surfaceLow)
    .contentShape(Rectangle())
    .onTapGesture(perform: action)
  }
}

// Under the inbox while it shows one topic: write to whatever listens on it,
// such as the Claude Code session working on it (pearbell mcp --channel).
// The answer comes back as a message on the topic.
struct AskBar: View {
  @EnvironmentObject var model: AppModel
  let topic: String
  @State private var draft = ""
  @FocusState private var focused: Bool

  static let progress = "What's the status? What's done, what are you on now, and what's next?"

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button("Progress?") { model.say(topic, AskBar.progress) }
        .buttonStyle(PillButtonStyle(filled: false))
        .help("Ask \(topic) for a status update")
      HStack(spacing: 8) {
        TextField("Ask \(topic)…", text: $draft)
          .textFieldStyle(.plain)
          .font(.system(size: 13))
          .focused($focused)
          .onSubmit(send)
        Button(action: send) {
          Image(systemName: "paperplane.fill")
            .foregroundStyle(empty ? Palette.outline : Palette.primary)
        }
        .buttonStyle(.plain)
        .disabled(empty)
        .accessibilityLabel("Send")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .background(Capsule().fill(Palette.surfaceLowest))
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surfaceContainer)
    .disabled(model.link != .connected)
    .help(model.link == .connected ? "" : "The pearbell daemon is not running")
    .onChange(of: model.askFocus) { _ in focused = true }
    .onChange(of: topic) { _ in draft = "" }
    .onAppear { if model.askFocus > 0 { focused = true } }
  }

  private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  private func send() {
    guard !empty else { return }
    model.say(topic, draft)
    draft = ""
  }
}

// What came of a message you wrote to a topic. The flag says someone heard it.
func heardStatus(_ message: Message, connected: Bool) -> (text: String, heard: Bool) {
  switch message.heard {
  case nil: return (connected ? "Sending…" : "Waiting for the daemon", false)
  case let n? where n > 0: return ("Heard by \(n) \(n == 1 ? "session" : "sessions")", true)
  default: return (message.queued ? "Queued for Claude's next step" : "Nobody listening on this Mac", false)
  }
}

// A small topic tag for message rows.
struct TopicTag: View {
  let topic: String

  var body: some View {
    Text(topic)
      .font(.system(size: 10, weight: .medium))
      .foregroundStyle(Palette.onSurfaceVariant)
      .lineLimit(1)
      .padding(.horizontal, 6)
      .padding(.vertical, 1)
      .background(Capsule().fill(Palette.surfaceContainer))
  }
}

extension View {
  // A keyboard shortcut, or none.
  @ViewBuilder
  func shortcut(_ key: KeyEquivalent?, modifiers: EventModifiers = .command) -> some View {
    if let key {
      keyboardShortcut(key, modifiers: modifiers)
    } else {
      self
    }
  }
}

// What a row shows behind it while you drag it.
struct SwipeBackground: View {
  let offset: CGFloat
  let archived: Bool

  // Full colour once the drag would act.
  private var strength: Double { Double(min(abs(offset) / CGFloat(90), CGFloat(1))) }

  var body: some View {
    ZStack {
      if offset > 0 {
        HStack {
          Image(systemName: "trash").padding(.leading, 20)
          Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.red.opacity(strength))
      } else if offset < 0 {
        HStack {
          Spacer()
          Image(systemName: archived ? "tray.and.arrow.up" : "archivebox").padding(.trailing, 20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.primary.opacity(strength))
      }
    }
    // The whole row, not just the icon's height.
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .foregroundStyle(.white)
    .font(.system(size: 15, weight: .semibold))
  }
}

// Archived messages, with the same rows and topic chips as the inbox.
struct ArchiveView: View {
  @EnvironmentObject var model: AppModel
  let close: () -> Void
  let showTopics: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          IconButton(symbol: "chevron.left", label: "Back", action: close)
            .keyboardShortcut(.cancelAction)
          Text("Archive")
            .font(.system(size: 22, weight: .semibold))
          Spacer()
        }
        TopicChips(onMore: showTopics)
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      .padding(.bottom, 8)

      ScrollView {
        if model.shownArchive.isEmpty {
          Text("Nothing archived. Drag a message to the left, or right-click it, to archive it.")
            .font(.system(size: 13))
            .foregroundStyle(Palette.onSurfaceVariant)
            .multilineTextAlignment(.center)
            .padding(.top, 60)
            .padding(.horizontal, 32)
        } else {
          VStack(spacing: 2) {
            ForEach(model.shownArchive) { message in
              MessageRow(message: message)
            }
          }
          .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
          .padding(.horizontal, 16)
          .padding(.bottom, 16)
        }
      }
    }
  }
}

// "Archived · Undo" at the bottom of the popover.
struct NoticeBar: View {
  @EnvironmentObject var model: AppModel

  var body: some View {
    if let notice = model.notice {
      HStack {
        Text(notice.text)
          .font(.system(size: 13, weight: .medium))
        Spacer()
        Button("Undo") { model.undo() }
          .buttonStyle(.plain)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Palette.primaryContainer)
          .keyboardShortcut("z", modifiers: .command)
      }
      .foregroundStyle(Palette.background)
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.onSurface))
      .padding(12)
      .transition(.move(edge: .bottom).combined(with: .opacity))
    }
  }
}
