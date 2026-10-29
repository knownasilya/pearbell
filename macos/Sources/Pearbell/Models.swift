import Foundation

// A frame from the daemon. Every kind of frame fits; unused keys are nil.
struct Frame: Decodable {
  struct Route: Decodable {
    let to: String
    let reason: String
  }

  let type: String
  let id: String?
  let title: String?
  let body: String?
  let topic: String?
  let actions: [String]?
  let wantsReply: Bool?
  let key: String?
  let update: Bool?
  let notify: Bool?
  let quiet: Bool?
  let rest: Rest?
  let route: Route?
  let sentAt: Double?
  let to: String?
  let reason: String?
  let answer: String?
  let device: String?
  let computer: String?
  let devices: [Device]?
  let open: [String]?
  let listeners: Int?
  let queued: Bool?
  let error: String?
}

// Rest hours (shared/rest.js): quiet nights from..until and rest days (0 is
// Sunday), one setting for the Mac and the phones. The daemon decides whether
// a message comes during them (Frame.quiet); the newest change wins.
struct Rest: Codable, Equatable {
  var on = false
  var nightly = true
  var from = "22:00"
  var until = "07:00"
  var days = [0]
  var updatedAt: Double = 0

  var frame: [String: Any] {
    ["on": on, "nightly": nightly, "from": from, "until": until, "days": days.sorted(), "updatedAt": updatedAt]
  }

  // "HH:MM" as a time today, for the pickers.
  static func date(_ time: String) -> Date {
    let parts = time.split(separator: ":").compactMap { Int($0) }
    let calendar = Calendar.current
    return calendar.date(bySettingHour: parts.first ?? 0, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
  }

  static func time(_ date: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: date)
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
  }
}

struct Device: Decodable, Identifiable, Equatable {
  let name: String
  let publicKey: String
  let connected: Bool
  var id: String { publicKey }
}

struct Message: Codable, Identifiable, Equatable {
  let id: String
  var title: String
  var body: String
  var topic: String
  var actions: [String]
  var wantsReply: Bool
  var receivedAt: Date
  var route: String // "mac", "phone" or "both"
  var reason: String
  var answer: String?
  var answeredBy: String?
  var closed: Bool
  var archived = false
  // The sender's own id (pearbell send --id), and when an update last changed it.
  var key: String? = nil
  var updatedAt: Date? = nil
  var updates = 0
  // Written here to a topic (AppModel.say), not received. heard is how many
  // listeners got it: nil until the daemon answers, 0 for nobody. queued says
  // the daemon keeps it for a Claude Code hook to take.
  var mine = false
  var heard: Int? = nil
  var queued = false

  var sender: String { mine ? "You" : title.isEmpty ? "pearbell" : title }
  // An open question in the inbox. An archived one stays open but out of the way.
  var waiting: Bool { wantsReply && answer == nil && !closed && !archived }
}

extension Message {
  // Inboxes saved before archiving have no "archived", before updates no "key",
  // and before asking a topic no "mine".
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try c.decode(String.self, forKey: .title)
    body = try c.decode(String.self, forKey: .body)
    topic = try c.decodeIfPresent(String.self, forKey: .topic) ?? ""
    actions = try c.decode([String].self, forKey: .actions)
    wantsReply = try c.decode(Bool.self, forKey: .wantsReply)
    receivedAt = try c.decode(Date.self, forKey: .receivedAt)
    route = try c.decode(String.self, forKey: .route)
    reason = try c.decode(String.self, forKey: .reason)
    answer = try c.decodeIfPresent(String.self, forKey: .answer)
    answeredBy = try c.decodeIfPresent(String.self, forKey: .answeredBy)
    closed = try c.decode(Bool.self, forKey: .closed)
    archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
    key = try c.decodeIfPresent(String.self, forKey: .key)
    updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt)
    updates = try c.decodeIfPresent(Int.self, forKey: .updates) ?? 0
    mine = try c.decodeIfPresent(Bool.self, forKey: .mine) ?? false
    heard = try c.decodeIfPresent(Int.self, forKey: .heard)
    queued = try c.decodeIfPresent(Bool.self, forKey: .queued) ?? false
  }
}

// The inbox on disk, in ~/Library/Application Support/pearbell.
enum Inbox {
  static let limit = 200

  static var file: URL {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("pearbell", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("messages.json")
  }

  static func load() -> [Message] {
    guard let data = try? Data(contentsOf: file) else { return [] }
    return (try? JSONDecoder().decode([Message].self, from: data)) ?? []
  }

  static func save(_ messages: [Message]) {
    guard let data = try? JSONEncoder().encode(Array(messages.prefix(limit))) else { return }
    try? data.write(to: file, options: .atomic)
  }
}

// Message text is Markdown (see Markdown.swift).
// Notifications show the text without the markup.
func plainText(_ text: String) -> String {
  Markdown.plain(text)
}
