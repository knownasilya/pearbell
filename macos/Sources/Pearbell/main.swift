// pearbell for macOS: a menu bar app that shows pearbell messages as Mac
// notifications while you are at the Mac, and lets the daemon send them to
// your phone when you are not. See macos/README.md.
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
