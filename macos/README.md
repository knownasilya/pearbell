# pearbell for macOS

A menu bar app that shows pearbell messages as Mac notifications while you are at the Mac, and lets them go to your phone when you are not.

It does not talk to the phone itself. It connects to the pearbell daemon on the same Mac over its local socket (the one the CLI uses), reports whether you are at the Mac, and gets every message. The daemon decides where each message shows up ([cli/router.js](../cli/router.js)):

| Situation | Where it shows up |
| --- | --- |
| You are using the Mac | A Mac notification. The phone stays quiet. |
| Snoozed from the moon menu | The phone, for an hour or until 8:00 tomorrow. |
| Screen locked, Mac or displays asleep, or no input for 5 minutes | The phone. The Mac keeps a quiet copy in its inbox. |
| A message on the Mac, and you step away before you touch the Mac again | It goes to the phone as well, so you see it somewhere. |
| A question on the Mac, and you step away or leave it for 3 minutes | It goes to the phone as well. Answer on either one; the other closes it. |
| Away, but no phone online | Both: the phone gets it when it reconnects, and the Mac notification waits for you. |
| No phone paired | The Mac. |
| The app is not running | The phone, as before. If you quit the app, open questions move to the phone. |

The menu has **Auto** (the rules above), **Always Mac** and **Always phone**, and you can change the idle time and when questions move on. `pearbell send --to mac|phone|all` and `-d <phone>` override the rules for one message.

The popover is the phone's inbox: open questions on top with their quick replies and a reply field, then recent messages. The menu bar icon shows how many questions wait.

- **Open a message:** click its notification, or its row in the inbox, to see all of it, with its topic, time and where it went. Esc goes back.
- **Markdown:** messages show **bold**, *italic*, `code`, ~~strike~~, headings, lists, task lists (`- [ ]` and `- [x]`), quotes, code blocks, tables and https images, like on the phone. Links and bare `https://` URLs open in your browser. Only http, https and mailto links open.
- **Updates:** `pearbell update <id>` changes a message sent with `--id <id>` in place, with no new banner or sound. The message then shows **updated** and the time of the last change.
- **Topics:** messages sent with `-T <topic>` get a tag, and chips under the header filter the inbox by topic. Notifications are grouped by topic too.
- **Archive and delete:** drag a message left to archive it, right to delete it, or right-click it. Undo shows for a few seconds. The archive button in the header lists archived messages.
- **Snooze:** the moon menu sends everything to the phone for an hour or until tomorrow morning. **Resume** ends it.
- **Keys:** ⌘1, ⌘2 and ⌘3 pick the quick replies of the first open question.

Notifications for questions carry the same buttons and a Reply field. In System Settings, set pearbell's notification style to **Alerts** so questions stay on screen. **Send a test message** in the app's settings checks that notifications show.

## Install

It needs macOS 13 or later, and the CLI (`npm install -g pearbell`).

- **A release:** download `pearbell-mac-vX.Y.Z.zip` from the [Releases](https://github.com/knownasilya/pearbell/releases) page, unzip it and move `pearbell.app` to Applications.
- **The latest build:** open the newest green run under [Actions](https://github.com/knownasilya/pearbell/actions/workflows/macos.yml) and download the `pearbell-mac` artifact.

The app is signed ad hoc, not notarized, so the first time, right-click it and choose **Open**. Allow notifications when it asks. Turn on **Open pearbell at login** in its settings, and run `pearbell service install` so the daemon is up at login too.

## Build it yourself

```bash
npm run mac:build   # macos/build/pearbell.app and pearbell-mac.zip, needs Xcode 15+
npm run mac:run     # build and open it
```

For quick iterations, `cd macos && swift run` runs it without an app bundle (notifications need the bundle, though).

## Layout

- [AppModel.swift](Sources/Pearbell/AppModel.swift): the inbox, settings and the frames from the daemon.
- [DaemonLink.swift](Sources/Pearbell/DaemonLink.swift): the socket to the daemon, redialed while it is down. The frames are listed in [cli/control.js](../cli/control.js).
- [Presence.swift](Sources/Pearbell/Presence.swift): idle time, screen lock and sleep.
- [Notifier.swift](Sources/Pearbell/Notifier.swift): notifications with quick replies.
- [PopoverView.swift](Sources/Pearbell/PopoverView.swift), [SettingsView.swift](Sources/Pearbell/SettingsView.swift), [Theme.swift](Sources/Pearbell/Theme.swift): the UI, in the Android app's colors.
