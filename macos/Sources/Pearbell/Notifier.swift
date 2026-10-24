import Foundation
import UserNotifications

// Mac notifications. A question gets its quick replies as buttons, plus a
// Reply field, like on the phone.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  // (message id, the action's label or the typed reply)
  var onAnswer: (String, String) -> Void = { _, _ in }
  // A click on the notification itself: open that message.
  var onOpen: (String) -> Void = { _ in }

  private let center = UNUserNotificationCenter.current()
  private var categories: [String: UNNotificationCategory] = [:]
  private var actions: [String: [String]] = [:]

  func setUp() {
    center.delegate = self
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
  }

  func show(_ message: Message) {
    let content = UNMutableNotificationContent()
    content.title = message.sender
    if !message.topic.isEmpty { content.subtitle = message.topic }
    content.body = plainText(message.body)
    content.sound = .default
    content.threadIdentifier = message.topic.isEmpty ? "pearbell" : message.topic

    if message.wantsReply {
      let category = "question-\(message.id)"
      var buttons = message.actions.enumerated().map { i, label in
        UNNotificationAction(identifier: "action-\(i)", title: label, options: [])
      }
      buttons.append(UNTextInputNotificationAction(
        identifier: "reply",
        title: "Reply",
        options: [],
        textInputButtonTitle: "Send",
        textInputPlaceholder: "Write a reply…"
      ))
      categories[category] = UNNotificationCategory(identifier: category, actions: buttons, intentIdentifiers: [], options: [])
      actions[message.id] = message.actions
      center.setNotificationCategories(Set(categories.values))
      content.categoryIdentifier = category
    }

    center.add(UNNotificationRequest(identifier: message.id, content: content, trigger: nil))
  }

  // Answered or closed: nothing to act on any more.
  func clear(_ id: String) {
    center.removeDeliveredNotifications(withIdentifiers: [id])
    actions[id] = nil
    if categories.removeValue(forKey: "question-\(id)") != nil {
      center.setNotificationCategories(Set(categories.values))
    }
  }

  // Show banners even while the popover is open.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound, .list])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let id = response.notification.request.identifier
    let action = response.actionIdentifier
    let typed = (response as? UNTextInputNotificationResponse)?.userText

    DispatchQueue.main.async {
      if let typed, !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        self.onAnswer(id, typed.trimmingCharacters(in: .whitespacesAndNewlines))
      } else if action.hasPrefix("action-"), let i = Int(action.dropFirst("action-".count)),
                let labels = self.actions[id], i < labels.count {
        self.onAnswer(id, labels[i])
      } else if action == UNNotificationDefaultActionIdentifier {
        self.onOpen(id)
      }
      completionHandler()
    }
  }
}
