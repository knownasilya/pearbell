import AppKit
import SwiftUI

// Routing settings, paired phones and the login item. Like the phone's
// Computers screen.
struct SettingsView: View {
  @EnvironmentObject var model: AppModel
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        IconButton(symbol: "chevron.left", label: "Back", action: close)
          .keyboardShortcut(.cancelAction)
        Text("Settings")
          .font(.system(size: 22, weight: .semibold))
        Spacer()
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      .padding(.bottom, 8)

      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          SectionTitle(text: "Where messages go")
          Group {
            Picker("", selection: $model.mode) {
              ForEach(AppModel.Mode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text(explanation)
              .font(.system(size: 12))
              .foregroundStyle(Palette.onSurfaceVariant)
              .fixedSize(horizontal: false, vertical: true)

            if model.mode == .auto {
              Row(label: "Away after no input for") {
                Picker("", selection: $model.idleAfter) {
                  Text("1 min").tag(60.0)
                  Text("2 min").tag(120.0)
                  Text("5 min").tag(300.0)
                  Text("10 min").tag(600.0)
                }
              }
              Row(label: "Unanswered questions go to the phone after") {
                Picker("", selection: $model.escalateAfter) {
                  Text("1 min").tag(60.0)
                  Text("3 min").tag(180.0)
                  Text("10 min").tag(600.0)
                  Text("Never").tag(0.0)
                }
              }
            }
          }
          .card()

          SectionTitle(text: "Rest hours")
          RestSettings()
            .card()

          SectionTitle(text: "Phones")
          VStack(alignment: .leading, spacing: 10) {
            if model.devices.isEmpty {
              Text("No phone paired yet. Run `pearbell pair` and scan the code in the Android app.")
                .font(.system(size: 12))
                .foregroundStyle(Palette.onSurfaceVariant)
            }
            ForEach(model.devices) { device in
              HStack(spacing: 10) {
                Avatar(name: device.name, size: 28)
                Text(device.name).font(.system(size: 13, weight: .semibold))
                Spacer()
                StatusDot(online: device.connected)
                Text(device.connected ? "Online" : "Offline")
                  .font(.system(size: 12))
                  .foregroundStyle(Palette.onSurfaceVariant)
              }
            }
          }
          .card()

          SectionTitle(text: "This Mac")
          VStack(alignment: .leading, spacing: 10) {
            Toggle("Open pearbell at login", isOn: Binding(
              get: { model.launchAtLogin },
              set: { model.launchAtLogin = $0 }
            ))
            .toggleStyle(.switch)
            .tint(Palette.primary)
            .font(.system(size: 13))

            HStack(spacing: 8) {
              Button("Send a test message") { model.sendTest() }
                .buttonStyle(PillButtonStyle(filled: false))
                .disabled(model.link != .connected)
              Button("Notification settings…") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.preference.notifications") {
                  NSWorkspace.shared.open(url)
                }
              }
              .buttonStyle(PillButtonStyle(filled: false))
            }
            if let error = model.testError {
              Text(error)
                .font(.system(size: 11))
                .foregroundStyle(Palette.tertiary)
            }
            Text("Pick the Alerts style there so questions stay on screen with their buttons.")
              .font(.system(size: 11))
              .foregroundStyle(Palette.onSurfaceVariant)
          }
          .card()

          HStack {
            Text("Messages reach this Mac through the daemon on \(model.computer).")
              .font(.system(size: 11))
              .foregroundStyle(Palette.outline)
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }
              .buttonStyle(PillButtonStyle(filled: false))
          }
          .padding(.top, 16)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
      }
    }
  }

  private var explanation: String {
    switch model.mode {
    case .auto:
      return "While you use this Mac, messages show up here. When it is locked, asleep or idle, they go to your phone, and so do the ones you did not see here before you stepped away. A question you leave unanswered here moves on to the phone."
    case .mac:
      return "Everything shows up on this Mac, even when you are away."
    case .phone:
      return "Everything goes to your phone. This Mac keeps a copy in the inbox, without notifications."
    }
  }
}

// Quiet nights and rest days, the same on the phone (its Computers screen).
private struct RestSettings: View {
  @EnvironmentObject var model: AppModel

  // Monday first, the way a week reads; 0 is Sunday as in shared/rest.js.
  private let week = [(1, "Monday"), (2, "Tuesday"), (3, "Wednesday"), (4, "Thursday"), (5, "Friday"), (6, "Saturday"), (0, "Sunday")]

  var body: some View {
    Toggle(isOn: binding(\.on)) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Quiet at bedtime and on rest days").font(.system(size: 13))
        Text("Messages still arrive, without a banner or a sound. Your phone uses the same hours.")
          .font(.system(size: 11))
          .foregroundStyle(Palette.onSurfaceVariant)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .toggleStyle(.switch)
    .tint(Palette.primary)

    if model.rest.on {
      HStack(spacing: 8) {
        Toggle("Bedtime", isOn: binding(\.nightly))
          .toggleStyle(.checkbox)
          .font(.system(size: 12))
        Spacer()
        if model.rest.nightly {
          time(\.from)
          Text("to").font(.system(size: 12)).foregroundStyle(Palette.onSurfaceVariant)
          time(\.until)
        }
      }

      HStack {
        Text("Rest days").font(.system(size: 12))
        Spacer()
        HStack(spacing: 4) {
          ForEach(week, id: \.0) { day, name in
            let picked = model.rest.days.contains(day)
            Button {
              var next = model.rest
              next.days = picked ? next.days.filter { $0 != day } : next.days + [day]
              model.setRest(next)
            } label: {
              Text(name.prefix(1))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(picked ? Palette.onPrimary : Palette.onSurfaceVariant)
                .frame(width: 24, height: 24)
                .background(Circle().fill(picked ? Palette.primary : Palette.surfaceContainer))
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(name)
            .accessibilityLabel(name)
            .accessibilityAddTraits(picked ? .isSelected : [])
          }
        }
      }
    }
  }

  private func time(_ key: WritableKeyPath<Rest, String>) -> some View {
    DatePicker("", selection: Binding(
      get: { Rest.date(model.rest[keyPath: key]) },
      set: { date in
        var next = model.rest
        next[keyPath: key] = Rest.time(date)
        if next != model.rest { model.setRest(next) }
      }
    ), displayedComponents: .hourAndMinute)
    .datePickerStyle(.stepperField)
    .labelsHidden()
    .fixedSize()
  }

  private func binding(_ key: WritableKeyPath<Rest, Bool>) -> Binding<Bool> {
    Binding(
      get: { model.rest[keyPath: key] },
      set: { value in
        var next = model.rest
        next[keyPath: key] = value
        model.setRest(next)
      }
    )
  }
}

private struct Row<Content: View>: View {
  let label: String
  @ViewBuilder let content: Content

  var body: some View {
    HStack {
      Text(label).font(.system(size: 12))
      Spacer()
      content
        .labelsHidden()
        .frame(width: 96)
    }
  }
}

private extension View {
  func card() -> some View {
    VStack(alignment: .leading, spacing: 12) { self }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Palette.surfaceLow))
  }
}
