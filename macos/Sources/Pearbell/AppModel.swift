import AppKit
import Foundation
import ServiceManagement

// Everything the popover shows, and the glue between the daemon link, the
// presence monitor and the notifications.
final class AppModel: ObservableObject {
  enum Link: Equatable {
    case connecting, connected, offline
    case outdated // the daemon does not know the menu bar app
  }

  enum Mode: String, CaseIterable, Identifiable {
    case auto, mac, phone
    var id: String { rawValue }
    var label: String {
      switch self {
      case .auto: return "Auto"
      case .mac: return "Always Mac"
      case .phone: return "Always phone"
      }
    }
  }

  @Published private(set) var link: Link = .connecting
  @Published private(set) var computer = Host.current().localizedName ?? "this Mac"
  @Published private(set) var devices: [Device] = []
  @Published private(set) var messages: [Message] = [] {
    didSet {
      // The topic picked in the inbox went away with its last message.
      if let topic, !messages.contains(where: { $0.topic == topic }) { self.topic = nil }
      if let focused, !messages.contains(where: { $0.id == focused }) { self.focused = nil }
    }
  }
  // The message open in the popover, or nil for the inbox.
  @Published var focused: String?
  // The topic the inbox shows, or nil for all.
  @Published var topic: String?
  // Why new messages go to the phone right now, or nil when they come here.
  @Published private(set) var away: String?
  @Published var startError: String?

  @Published var mode: Mode { didSet { saveSettings() } }
  @Published var idleAfter: Double { didSet { saveSettings() } }
  @Published var escalateAfter: Double { didSet { saveSettings() } }

  var onOpen: () -> Void = {}

  var waiting: [Message] { messages.filter(\.waiting) }
  var recent: [Message] { messages.filter { !$0.waiting } }
  var shownWaiting: [Message] { waiting.filter(inTopic) }
  var shownRecent: [Message] { recent.filter(inTopic) }

  // Topics in the inbox, most used first, like the phone.
  var topics: [(name: String, count: Int)] {
    Dictionary(grouping: messages.map(\.topic).filter { !$0.isEmpty }, by: { $0 })
      .map { (name: $0.key, count: $0.value.count) }
      .sorted { $0.count != $1.count ? $0.count > $1.count : $0.name.lowercased() < $1.name.lowercased() }
  }

  private func inTopic(_ message: Message) -> Bool {
    topic == nil || message.topic == topic
  }
  var onlinePhones: [Device] { devices.filter(\.connected) }

  private let daemon = DaemonLink()
  private let presence = PresenceMonitor()
  private let notifier = Notifier()
  private var timer: Timer?

  init() {
    let defaults = UserDefaults.standard
    mode = Mode(rawValue: defaults.string(forKey: "mode") ?? "") ?? .auto
    idleAfter = defaults.object(forKey: "idleAfter") as? Double ?? 300
    escalateAfter = defaults.object(forKey: "escalateAfter") as? Double ?? 180
    messages = Inbox.load()

    daemon.hello = { [weak self] in
      ["type": "mac", "presence": self?.presenceFrame() ?? [:]]
    }
    daemon.onState = { [weak self] up in
      guard let self else { return }
      // Stay on "outdated" until a daemon accepts us; setting the same value
      // would still redraw the popover.
      let next: Link = up ? .connected : (self.link == .outdated ? .outdated : .offline)
      if self.link != next { self.link = next }
    }
    daemon.onError = { [weak self] _ in
      if self?.link != .outdated { self?.link = .outdated }
    }
    daemon.onFrame = { [weak self] frame in
      self?.handle(frame)
    }
    presence.onChange = { [weak self] in
      self?.pushPresence()
    }
    notifier.onAnswer = { [weak self] id, text in
      self?.answer(id, text)
    }
    notifier.onOpen = { [weak self] id in
      guard let self else { return }
      self.focused = self.messages.contains(where: { $0.id == id }) ? id : nil
      self.onOpen()
    }
  }

  func start() {
    notifier.setUp()
    daemon.start()
    updateAway()
    // Idle time only grows, so report it every few seconds; the daemon counts
    // on from the last report in between.
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.pushPresence()
    }
  }

  // MARK: Actions from the UI

  func answer(_ id: String, _ text: String) {
    guard let i = messages.firstIndex(where: { $0.id == id }), messages[i].waiting, link == .connected else { return }
    daemon.send(["type": "reply", "id": id, "text": text])
    messages[i].answer = text
    messages[i].answeredBy = nil
    notifier.clear(id)
    Inbox.save(messages)
  }

  func delete(_ id: String) {
    messages.removeAll { $0.id == id }
    notifier.clear(id)
    Inbox.save(messages)
  }

  func clearRecent() {
    messages.removeAll { !$0.waiting }
    Inbox.save(messages)
  }

  // Start the daemon through the CLI, from a login shell so PATH has npm's bin.
  func startDaemon() {
    startError = nil
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", "pearbell start"]
    process.terminationHandler = { [weak self] p in
      DispatchQueue.main.async {
        if p.terminationStatus != 0 {
          self?.startError = "Could not run pearbell. Install it with: npm install -g pearbell"
        }
        self?.daemon.kick()
      }
    }
    do {
      try process.run()
    } catch {
      startError = error.localizedDescription
    }
  }

  var launchAtLogin: Bool {
    get { SMAppService.mainApp.status == .enabled }
    set {
      objectWillChange.send()
      do {
        if newValue {
          try SMAppService.mainApp.register()
        } else {
          try SMAppService.mainApp.unregister()
        }
      } catch {
        startError = "Could not change the login item: \(error.localizedDescription)"
      }
    }
  }

  // MARK: Daemon frames

  private func handle(_ frame: Frame) {
    switch frame.type {
    case "state":
      if let name = frame.computer, name != computer { computer = name }
      let next = frame.devices ?? []
      if next != devices { devices = next }
      updateAway()

    case "msg":
      guard let id = frame.id else { return }
      daemon.send(["type": "ack", "id": id])
      let route = frame.route?.to ?? "mac"
      let reason = frame.route?.reason ?? ""
      if let i = messages.firstIndex(where: { $0.id == id }) {
        messages[i].route = route
        messages[i].reason = reason
      } else {
        let message = Message(
          id: id,
          title: frame.title ?? "",
          body: frame.body ?? "",
          topic: frame.topic ?? "",
          actions: frame.actions ?? [],
          wantsReply: frame.wantsReply ?? false,
          receivedAt: frame.sentAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date(),
          route: route,
          reason: reason,
          answer: nil,
          answeredBy: nil,
          closed: false
        )
        messages.insert(message, at: 0)
        messages.sort { $0.receivedAt > $1.receivedAt }
        if frame.notify == true { notifier.show(message) }
      }
      Inbox.save(messages)

    case "routed":
      guard let id = frame.id, let i = messages.firstIndex(where: { $0.id == id }) else { return }
      messages[i].route = frame.to ?? "phone"
      messages[i].reason = frame.reason ?? ""
      Inbox.save(messages)

    case "closed":
      guard let id = frame.id else { return }
      notifier.clear(id)
      guard let i = messages.firstIndex(where: { $0.id == id }) else { return }
      messages[i].closed = true
      if let answer = frame.answer {
        messages[i].answer = answer
        messages[i].answeredBy = frame.device == "this Mac" ? nil : frame.device
      }
      Inbox.save(messages)

    case "synced":
      // Questions the daemon forgot (it restarted) can't be answered any more.
      let open = Set(frame.open ?? [])
      for i in messages.indices where messages[i].waiting && !open.contains(messages[i].id) {
        messages[i].closed = true
        notifier.clear(messages[i].id)
      }
      Inbox.save(messages)

    default:
      break
    }
  }

  // MARK: Presence

  private func presenceFrame() -> [String: Any] {
    [
      "idle": presence.idle,
      "locked": presence.locked,
      "asleep": presence.asleep,
      "mode": mode.rawValue,
      "idleAfter": idleAfter,
      "escalateAfter": escalateAfter
    ]
  }

  private func pushPresence() {
    var frame = presenceFrame()
    frame["type"] = "presence"
    daemon.send(frame)
    updateAway()
  }

  // The same rules as cli/router.js, to say in the popover where messages go.
  private func updateAway() {
    let reason: String?
    if devices.isEmpty || mode == .mac {
      reason = nil
    } else if mode == .phone {
      reason = "set to Always phone"
    } else if presence.asleep {
      reason = "the Mac is asleep"
    } else if presence.locked {
      reason = "the screen is locked"
    } else if presence.idle >= idleAfter {
      reason = "you have been away for a while"
    } else {
      reason = nil
    }
    if reason != away { away = reason }
  }

  private func saveSettings() {
    let defaults = UserDefaults.standard
    defaults.set(mode.rawValue, forKey: "mode")
    defaults.set(idleAfter, forKey: "idleAfter")
    defaults.set(escalateAfter, forKey: "escalateAfter")
    pushPresence()
  }
}
