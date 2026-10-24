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
  let notify: Bool?
  let route: Route?
  let sentAt: Double?
  let to: String?
  let reason: String?
  let answer: String?
  let device: String?
  let computer: String?
  let devices: [Device]?
  let open: [String]?
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

  var sender: String { title.isEmpty ? "pearbell" : title }
  var waiting: Bool { wantsReply && answer == nil && !closed }
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

// Message text is Markdown; the inbox shows the inline parts of it.
func markdown(_ text: String) -> AttributedString {
  let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
  return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

// Notifications show the text without the markup.
func plainText(_ text: String) -> String {
  String(markdown(text).characters)
}
