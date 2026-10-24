import CryptoKit
import Foundation
import Network

// One long-lived connection to the pearbell daemon's local socket, redialed
// with a back-off while the daemon is not running. Newline-delimited JSON,
// see cli/control.js for the frames. Callbacks run on the main queue.
final class DaemonLink {
  var hello: () -> [String: Any] = { [:] }
  var onFrame: (Frame) -> Void = { _ in }
  var onState: (Bool) -> Void = { _ in }

  private var conn: NWConnection?
  private var buffer = Data()
  private var delay: TimeInterval = 1
  private var redial: DispatchWorkItem?

  func start() {
    dial()
  }

  // Try again now, for example after starting the daemon.
  func kick() {
    delay = 1
    if conn == nil {
      redial?.cancel()
      dial()
    }
  }

  func send(_ frame: [String: Any]) {
    guard let conn, case .ready = conn.state,
          var data = try? JSONSerialization.data(withJSONObject: frame) else { return }
    data.append(0x0A)
    conn.send(content: data, completion: .contentProcessed { _ in })
  }

  private func dial() {
    let c = NWConnection(to: .unix(path: DaemonLink.socketPath()), using: .tcp)
    conn = c
    buffer = Data()
    c.stateUpdateHandler = { [weak self, weak c] state in
      guard let self, let c, c === self.conn else { return }
      switch state {
      case .ready:
        self.delay = 1
        self.onState(true)
        self.send(self.hello())
        self.receive(c)
      case .failed, .waiting:
        self.drop(c)
      default:
        break
      }
    }
    c.start(queue: .main)
  }

  private func receive(_ c: NWConnection) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, error in
      guard let self, c === self.conn else { return }
      if let data, !data.isEmpty {
        self.buffer.append(data)
        while let newline = self.buffer.firstIndex(of: 0x0A) {
          let line = self.buffer.subdata(in: self.buffer.startIndex..<newline)
          self.buffer.removeSubrange(self.buffer.startIndex...newline)
          if let frame = try? JSONDecoder().decode(Frame.self, from: line) {
            self.onFrame(frame)
          }
        }
      }
      if done || error != nil {
        self.drop(c)
      } else {
        self.receive(c)
      }
    }
  }

  private func drop(_ c: NWConnection) {
    guard c === conn else { return }
    conn = nil
    c.cancel()
    onState(false)

    let work = DispatchWorkItem { [weak self] in self?.dial() }
    redial = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    delay = min(delay * 2, 10)
  }

  // Same rules as socketPath() in cli/control.js.
  static func home() -> String {
    if let home = ProcessInfo.processInfo.environment["PEARBELL_HOME"], !home.isEmpty { return home }
    return (NSHomeDirectory() as NSString).appendingPathComponent(".config/pearbell")
  }

  static func socketPath() -> String {
    let home = home()
    let preferred = (home as NSString).appendingPathComponent("daemon.sock")
    if preferred.utf16.count < 100 { return preferred }

    let hash = SHA256.hash(data: Data(home.utf8)).map { String(format: "%02x", $0) }.joined().prefix(12)
    let tmp = ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory()
    return (tmp as NSString).appendingPathComponent("pearbell-\(hash).sock")
  }
}
