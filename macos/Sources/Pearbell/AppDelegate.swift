import AppKit
import Combine
import SwiftUI

// The menu bar item and its popover.
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
  let model = AppModel()
  private var item: NSStatusItem!
  private let popover = NSPopover()
  private var changes: AnyCancellable?
  private var closedAt = Date.distantPast
  private var icon = ""

  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.target = self
    item.button?.action = #selector(toggle)

    popover.behavior = .transient
    popover.delegate = self
    popover.animates = true
    popover.contentSize = NSSize(width: 380, height: 580)
    popover.contentViewController = NSHostingController(rootView: PopoverView().environmentObject(model))

    // Opened from a notification: wait for its banner to go, or the popover
    // closes again as the click moves focus.
    model.onOpen = { [weak self] in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self?.show() }
    }
    // objectWillChange fires before the change lands, so look a beat later.
    changes = model.objectWillChange
      .debounce(for: .milliseconds(50), scheduler: RunLoop.main)
      .sink { [weak self] _ in self?.updateIcon() }
    updateIcon()
    model.start()
  }

  @objc private func toggle() {
    if popover.isShown {
      popover.performClose(nil)
    } else if Date().timeIntervalSince(closedAt) > 0.3 {
      // A click on the icon while it was open already closed it.
      model.focused = nil
      show()
    }
  }

  func popoverDidClose(_ notification: Notification) {
    closedAt = Date()
  }

  private func show() {
    guard let button = item.button else { return }
    NSApp.activate(ignoringOtherApps: true)
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    popover.contentViewController?.view.window?.makeKey()
  }

  private func updateIcon() {
    let symbol: String
    if model.link != .connected {
      symbol = "bell.slash"
    } else if !model.waiting.isEmpty {
      symbol = "bell.badge"
    } else {
      symbol = "bell"
    }
    if symbol != icon {
      icon = symbol
      let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "pearbell")
      image?.isTemplate = true
      item.button?.image = image
    }
    item.button?.toolTip = model.waiting.isEmpty ? "pearbell" : "pearbell: \(model.waiting.count) waiting for you"
  }
}
