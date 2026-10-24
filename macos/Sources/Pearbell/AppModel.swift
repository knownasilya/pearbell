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
  @Published private(set) var testError: String?

  @Published var mode: Mode { didSet { saveSettings() } }
  @Published var idleAfter: Double { didSet { saveSettings() } }
  @Published var escalateAfter: Double { didSet { saveSettings() } }
  // "Send to phone for 1 hour": everything goes to the phone until then.
  @Published private(set) var snoozedUntil: Date? { didSet { saveSettings() } }

  var onOpen: () -> Void = {}

  var waiting: [Message] { messages.filter(\.waiting) }
  var recent: [Message] { messages.filter { !$0.waiting && !$0.archived } }
  var shownWaiting: [Message] { waiting.filter(inTopic) }
  var shownRecent: [Message] { recent.filter(inTopic) }
  var shownArchive: [Message] { messages.filter { $0.archived && inTopic($0) } }

  // "Archived" or "Deleted", with Undo, for a few seconds.
  struct Notice: Equatable {
    let text: String
    let id: String
  }
  @Published private(set) var notice: Notice?
  private var trash: [(message: Message, index: Int)] = []
  private var noticeTimer: Timer?

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
    snoozedUntil = (defaults.object(forKey: "snoozedUntil") as? Date).flatMap { $0 > Date() ? $0 : nil }
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

  func snooze(until date: Date?) {
    snoozedUntil = date
  }

  // Out of the inbox, into the archive. An open question stays open (the
  // phone can still answer it), but its notification goes.
  func archive(_ id: String, _ archived: Bool = true) {
    guard let i = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[i].archived = archived
    if archived { notifier.clear(id) }
    Inbox.save(messages)
    show(Notice(text: archived ? "Archived" : "Moved to the inbox", id: id))
  }

  func delete(_ id: String) {
    guard let i = messages.firstIndex(where: { $0.id == id }) else { return }
    trash.append((messages[i], i))
    messages.remove(at: i)
    notifier.clear(id)
    Inbox.save(messages)
    show(Notice(text: "Deleted", id: id))
  }

  func undo() {
    guard let notice else { return }
    if let t = trash.lastIndex(where: { $0.message.id == notice.id }) {
      let (message, index) = trash.remove(at: t)
      messages.insert(message, at: min(index, messages.count))
    } else if let i = messages.firstIndex(where: { $0.id == notice.id }) {
      messages[i].archived.toggle()
    }
    Inbox.save(messages)
    self.notice = nil
  }

  private func show(_ notice: Notice) {
    self.notice = notice
    noticeTimer?.invalidate()
    noticeTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
      self?.notice = nil
      self?.trash.removeAll()
    }
  }

  func clearRecent() {
    messages.removeAll { !$0.waiting && !$0.archived }
    Inbox.save(messages)
  }

  // Start the daemon through the CLI, from a login shell so PATH has npm's bin.
  func startDaemon() {
    startError = nil
    pearbell("start") { [weak self] ok in
      if !ok { self?.startError = "Could not run pearbell. Install it with: npm install -g pearbell" }
      self?.daemon.kick()
    }
  }

  // A message through the daemon to this Mac, to check that notifications show.
  func sendTest() {
    testError = nil
    pearbell("send --to mac -t pearbell 'This is a test message. Notifications work.'") { [weak self] ok in
      if !ok { self?.testError = "The test message did not reach this Mac. Is the daemon up to date?" }
    }
  }

  // Runs the CLI in a login shell, so it finds it the way a terminal does.
  private func pearbell(_ arguments: String, done: @escaping (Bool) -> Void) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", "pearbell \(arguments)"]
    process.terminationHandler = { p in
      DispatchQueue.main.async { done(p.terminationStatus == 0) }
    }
    do {
      try process.run()
    } catch {
      done(false)
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
      // An update edits the newest message with its key, quietly (see shared/protocol.js).
      if frame.update == true, let key = frame.key, let i = messages.firstIndex(where: { $0.key == key }) {
        if let title = frame.title, !title.isEmpty { messages[i].title = title }
        if let topic = frame.topic, !topic.isEmpty { messages[i].topic = topic }
        messages[i].body = frame.body ?? ""
        messages[i].updatedAt = Date()
        messages[i].updates += 1
        notifier.refresh(messages[i])
      } else if let i = messages.firstIndex(where: { $0.id == id }) {
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
          closed: false,
          key: frame.key
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
      "escalateAfter": escalateAfter,
      "snoozedUntil": (snoozedUntil?.timeIntervalSince1970 ?? 0) * 1000
    ]
  }

  private func pushPresence() {
    if let until = snoozedUntil, until <= Date() {
      snoozedUntil = nil // saveSettings pushes presence again
      return
    }
    var frame = presenceFrame()
    frame["type"] = "presence"
    daemon.send(frame)
    updateAway()
  }

  // The same rules as cli/router.js, to say in the popover where messages go.
  private func updateAway() {
    let reason: String?
    if let until = snoozedUntil, !devices.isEmpty {
      let time = until.formatted(date: .omitted, time: .shortened)
      reason = Calendar.current.isDateInToday(until) ? "snoozed until \(time)" : "snoozed until tomorrow \(time)"
    } else if devices.isEmpty || mode == .mac {
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
    defaults.set(snoozedUntil, forKey: "snoozedUntil")
    pushPresence()
  }
}
