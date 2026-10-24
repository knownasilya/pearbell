import AppKit
import SwiftUI

// The popover under the menu bar icon: the phone app's inbox, Mac sized.
struct PopoverView: View {
  @EnvironmentObject var model: AppModel
  @State private var showSettings = false

  var body: some View {
    VStack(spacing: 0) {
      if showSettings {
        SettingsView(close: { showSettings = false })
      } else {
        header
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            if model.link == .offline {
              DaemonCard()
                .padding(.top, 8)
            }
            if model.waiting.isEmpty && model.recent.isEmpty {
              EmptyInbox()
            } else {
              if !model.waiting.isEmpty {
                SectionTitle(text: "Waiting for you", count: model.waiting.count)
                ForEach(model.waiting) { message in
                  QuestionCard(message: message)
                    .padding(.bottom, 12)
                }
              }
              if !model.recent.isEmpty {
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
                  ForEach(model.recent) { message in
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
      }
    }
    .frame(width: 380, height: 580)
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
        IconButton(symbol: "gearshape", label: "Settings") { showSettings = true }
      }
      StatusPill()
      RouteLine()
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
  @State private var draft = ""

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

      Text(markdown(message.body))
        .font(.system(size: 15))
        .lineSpacing(3)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 12)

      if !message.actions.isEmpty {
        HStack(spacing: 8) {
          ForEach(Array(message.actions.enumerated()), id: \.offset) { i, label in
            Button(label) { model.answer(message.id, label) }
              .buttonStyle(PillButtonStyle(filled: i == 0))
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
    .padding(16)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(Palette.primaryContainer.opacity(0.45))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(Palette.primary.opacity(0.35), lineWidth: 1)
    )
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
  @State private var expanded = false

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Avatar(name: message.sender, size: 36)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(message.sender)
            .font(.system(size: 13, weight: .semibold))
            .lineLimit(1)
          if !message.topic.isEmpty {
            Text(message.topic)
              .font(.system(size: 10, weight: .medium))
              .foregroundStyle(Palette.onSurfaceVariant)
              .padding(.horizontal, 6)
              .padding(.vertical, 1)
              .background(Capsule().fill(Palette.surfaceContainer))
          }
          Spacer()
          Text(ago(message.receivedAt))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Palette.onSurfaceVariant)
        }
        Text(markdown(message.body))
          .font(.system(size: 13))
          .foregroundStyle(Palette.onSurfaceVariant)
          .lineLimit(expanded ? nil : 3)
          .textSelection(.enabled)
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
    .onTapGesture { expanded.toggle() }
    .contextMenu {
      Button("Copy text") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.body, forType: .string)
      }
      Button("Delete", role: .destructive) { model.delete(message.id) }
    }
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
  let when = ago(message.receivedAt)
  switch message.route {
  case "both": return "\(when) · also on your phone"
  case "phone": return "\(when) · sent to your phone"
  default: return when
  }
}

func ago(_ date: Date) -> String {
  let seconds = Date().timeIntervalSince(date)
  if seconds < 60 { return "now" }
  if seconds < 3600 { return "\(Int(seconds / 60)) min" }
  if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
  return date.formatted(.dateTime.month(.abbreviated).day())
}
