import AppKit
import CoreGraphics

// Whether you are at the Mac: seconds since the last keyboard or mouse
// input, a locked screen (or screen saver), and sleep (of the Mac or just
// its displays). The daemon's router (cli/router.js) turns this into a route.
final class PresenceMonitor {
  var onChange: () -> Void = {}
  private(set) var locked = false
  private(set) var asleep = false
  private var tokens: [NSObjectProtocol] = []

  init() {
    let distributed = DistributedNotificationCenter.default()
    let workspace = NSWorkspace.shared.notificationCenter

    observe(distributed, "com.apple.screenIsLocked") { $0.locked = true }
    observe(distributed, "com.apple.screenIsUnlocked") { $0.locked = false }
    observe(distributed, "com.apple.screensaver.didstart") { $0.locked = true }
    observe(distributed, "com.apple.screensaver.didstop") { $0.locked = false }
    observe(workspace, NSWorkspace.willSleepNotification.rawValue) { $0.asleep = true }
    observe(workspace, NSWorkspace.didWakeNotification.rawValue) { $0.asleep = false }
    observe(workspace, NSWorkspace.screensDidSleepNotification.rawValue) { $0.asleep = true }
    observe(workspace, NSWorkspace.screensDidWakeNotification.rawValue) { $0.asleep = false }
  }

  // Seconds since any keyboard, mouse or trackpad input.
  var idle: TimeInterval {
    guard let anyInput = CGEventType(rawValue: ~0) else { return 0 }
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
  }

  private func observe(_ center: NotificationCenter, _ name: String, _ apply: @escaping (PresenceMonitor) -> Void) {
    tokens.append(center.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      apply(self)
      self.onChange()
    })
  }
}
