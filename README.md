# pearbell

Send a message from your terminal to your Android phone. Get the answer back. No server, no account.

pearbell is a small ntfy.sh alternative for AI coding tools. An agent can tell you that a job is done, or ask you a question and wait for your reply. It runs on the [Pear](https://pears.com/) peer-to-peer stack: HyperDHT finds the peers and opens an end-to-end encrypted Noise connection, and Bare Kit runs the same JavaScript inside the Android app.

```bash
pearbell send -t "Claude Code" "Refactor done, 42 tests pass"
pearbell ask -a "Yes,No" "Push the branch to origin?"   # prints: Yes
```

<p align="center">
  <img src="docs/inbox-light.png" width="270" alt="The pearbell inbox in light mode: an open question with Ship it and Hold buttons, and earlier messages below">
  &nbsp;
  <img src="docs/inbox-dark.png" width="270" alt="The same inbox in dark mode">
</p>

## Quick start

Install the CLI and the app first (see [Install the CLI](#install-the-cli) and [Install the Android app](#install-the-android-app)). Then:

**1. Pair once.** On your computer:

```console
$ pearbell pair
█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█
█ ███ █ ▀█▄ █ ███ █      (a QR code)
▀▀▀▀▀▀▀ ▀ ▀ ▀▀▀▀▀▀▀
Scan this in the pearbell app, or paste the code:

  pearbell1:3ideim8m3uw7qwhh…:b7df5544a8114e40…

Waiting for the phone...
Paired with Pixel 8
```

In the app, give the phone a name (it starts as the device name from Android's settings), then tap **Scan QR code** (or **Enter the code instead** and paste it). The CLI prints the phone's name, the app says "You're paired", and the inbox shows "Connected to" your computer. You can rename the phone later on the app's Computers screen; paired computers pick up the new name.

**2. Send a notification.** It arrives as a normal Android notification and lands in the inbox. In the app, tap a message to see which computer sent it and exactly when. Swipe left to archive it, right to delete it (both can be undone).

```console
$ pearbell send -t "GitHub Actions" "CI passed on main · 3m 12s"
delivered to Pixel 8
```

**3. Ask a question and wait.** `ask` blocks until you answer on the phone, then prints the answer to stdout:

```console
$ pearbell ask -t "Claude Code" -a "Ship it,Hold" "Tests are green. Deploy v0.2.0 to production?"
delivered to Pixel 8
Ship it
```

<p align="center">
  <img src="docs/notification.png" width="360" alt="An Android notification from Claude Code with Ship it, Hold and Reply buttons">
</p>

Answer from the notification (tap a button, or **Reply** to type) or from the app's **Waiting for you** card. Only the answer goes to stdout; progress lines go to stderr. So scripts can branch on it:

```bash
answer=$(pearbell ask -q -a "Ship it,Hold" "Deploy v0.2.0?") || exit 1
if [ "$answer" = "Ship it" ]; then ./deploy.sh; fi
```

If nobody answers in time, `ask` exits with code `2` (the default timeout is 10 minutes; change it with `--timeout`).

## How it works

```
 terminal                       your computer                          phone
 ─────────                      ─────────────                          ─────
 pearbell send ──unix socket──▶ pearbell daemon ◀──HyperDHT (Noise)─── pearbell app
 pearbell ask  ◀── reply ─────  (auto-started)  ─── msg ─────────────▶ notification
                                                ◀── reply ───────────  (buttons / text)
```

- **The phone always dials the computer.** Many phones sit behind carrier NATs that refuse incoming connections. So the app keeps one open connection to each paired computer and redials when it drops (1 s back-off, up to 30 s, and at once on a network change).
- **The daemon** listens on the computer's HyperDHT key. Any `pearbell` command starts it in the background. It holds messages until each phone has them (up to a day), so a phone that is offline gets them later.
- **Pairing** uses a one-time code: the computer's public key plus a random token. After pairing, each side only accepts the other's key.
- **Replies** come from the notification (quick buttons or a typed reply) or from the app. If the phone is offline when you answer, the reply goes out when it reconnects.

## Install the CLI

You need Node 20 or later.

```bash
npm install -g pearbell
pearbell --help
```

To update, run `npm install -g pearbell@latest`. To remove it, run `npm uninstall -g pearbell`.

To hack on it instead, use a clone:

```bash
git clone https://github.com/knownasilya/pearbell && cd pearbell
npm install
npm link        # puts this checkout's `pearbell` on your PATH
```

Identity and paired phones live in `~/.config/pearbell/` (set `PEARBELL_HOME` to change it). The daemon logs to `daemon.log` in the same folder.

## Install the Android app

It needs Android 10 or later. Get the APK one of these ways:

- **A release:** download `pearbell-vX.Y.Z.apk` from the [Releases](https://github.com/knownasilya/pearbell/releases) page.
- **The latest build:** open the newest green run under [Actions](https://github.com/knownasilya/pearbell/actions/workflows/android.yml) and download the `pearbell-apk` artifact (a zip with the APK inside).

Open the APK on the phone and allow installs from that source. Or, with USB debugging on: `adb install pearbell-*.apk`.

**Updates.** The app checks the GitHub releases every few hours and installs new versions itself. Android asks you to confirm the first update; on Android 12 and later, the ones after that can install without a prompt. Turn this off, or check by hand, on the Computers screen.

> **Coming from v0.1.0?** It was signed with a throwaway key, so it can't update itself. Uninstall it once and install v0.2.0 or later by hand; updates work from then on. (You'll need to pair again.)

On first start, allow notifications. Then tap **Allow** on the "Stay reachable" card. Without it, Android may cut the connection while the screen is off.

### Build it yourself

```bash
npm run android:fetch-bare-kit   # once; downloads the Bare Kit prebuild (~400 MB zip, needs gh)
npm run android:build            # android/app/build/outputs/apk/release/app-release.apk
```

Building needs JDK 17 or later and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `android/local.properties`). With the phone plugged in, `npm run android:install` installs a debug build.

### CI and releases

[.github/workflows/android.yml](.github/workflows/android.yml) runs the tests and builds the APK on every push and pull request. To publish a release, push a tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

**Signing.** Android installs an update only if it is signed with the same key as the installed app, so releases are signed with one long-lived key from the repository secrets below. Never lose or replace it: apps signed with the old key could not update anymore. Without these secrets (in a fork, say), CI signs each build with a new throwaway key. To create a key:

```bash
keytool -genkeypair -keystore pearbell.jks -alias pearbell -keyalg RSA -keysize 4096 -validity 10000
gh secret set ANDROID_KEYSTORE_BASE64 < <(base64 -i pearbell.jks)
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body pearbell
gh secret set ANDROID_KEY_PASSWORD
```

## All commands

You can pair one phone with many computers, and one computer with many phones. `send` and `ask` go to every paired phone unless you pick one with `-d`; the first answer wins, and the other phones close the question.

```bash
pearbell send "Build finished"                 # notification
pearbell send -t "CI" -d pixel "Deploy done"   # title, one phone only
pearbell ask "Which branch name?"              # waits, prints the reply
pearbell ask -a "Approve,Reject" "Run migration 0042?"
git log -1 | pearbell send -t "New commit" -   # body from stdin
pearbell ask --json "Continue?"                # {"id":"…","reply":"…","device":"…"}

pearbell devices    # paired phones, online or not
pearbell unpair pixel
pearbell stop       # stop the background daemon
```

| Option | Meaning |
| --- | --- |
| `-t, --title` | Notification title |
| `-a, --actions a,b,c` | Up to 3 quick-reply buttons (the notification shows 2 plus Reply) |
| `-d, --device` | Only this phone (name or start of its key) |
| `-w, --wait` | Wait for a reply (`send -w` is `ask`) |
| `--timeout s` | `send`: wait this long for delivery (default 10). `ask`: wait this long for a reply (default 600). `0` waits forever. |
| `--json` | Machine-readable output |
| `-q, --quiet` | No progress lines on stderr |

Exit codes: `0` ok, `1` error, `2` timeout. When `send` times out before delivery, it still exits `0`: the message waits in the daemon's queue.

### Markdown

Message text is Markdown. The app shows **bold**, *italic*, `code`, ~~strike~~, headings, lists, quotes and fenced code blocks. Links (`[text](https://…)`, `<https://…>` or a bare `https://…`) open in the browser when you tap them on a question card or in a message's details. Only `http`, `https` and `mailto` links open. Notifications show the text without the markup.

```bash
pearbell ask -a "Ship it,Hold" "## Deploy ready
PR **#42** is green: [view it](https://github.com/you/app/pull/42)
- \`npm test\`: 211 passed"
```

## HTTP API

Some tools can only make web requests: a [Kody](https://github.com/kentcdodds/kody-celld) job, a webhook relay, iOS Shortcuts. For those, the daemon can also listen on a local port:

```bash
pearbell http on            # prints the URL (http://127.0.0.1:7457) and a token
pearbell http               # show them again
pearbell http rotate        # new token
pearbell http off
```

It listens on `127.0.0.1` only, and every request needs `Authorization: Bearer <token>`.

```bash
curl -s http://127.0.0.1:7457/send -H "authorization: Bearer $TOKEN" \
  -d '{"title":"Build","body":"**Tests passed**"}'
# {"id":"…","delivered":["Pixel 8"],"queued":[]}

curl -s http://127.0.0.1:7457/send -H "authorization: Bearer $TOKEN" \
  -d '{"body":"Deploy?","actions":["Yes","No"],"wait":true,"timeout":300}'
# {"id":"…","reply":"Yes","device":"Pixel 8"}   (504 {"error":"timeout"} if no answer)
```

| Endpoint | Body | Answer |
| --- | --- | --- |
| `POST /send` | `body` (required), `title`, `actions` (array or `"a,b"`), `device`, `wait`, `timeout` (seconds) | `{ id, delivered, queued }`, or with `wait`: `{ id, reply, device }` |
| `GET /devices` | | `[{ name, publicKey, connected }]` |

Without `wait`, `timeout` is how long to wait for delivery (default 10 s); a phone that is offline gets the message later. With `wait`, it is how long to wait for a reply (default 600 s).

## Use it with AI tools

**Claude Code hooks.** Put this in `~/.claude/settings.json` to get a ping when Claude needs you or finishes:

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "jq -r .message | pearbell send -q -t 'Claude Code' -" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "pearbell send -q -t 'Claude Code' 'Finished, waiting for you'" }] }
    ]
  }
}
```

**Let the agent ask you.** Add to `CLAUDE.md` or `AGENTS.md`:

```md
When you need a decision from me and I seem away, run
`pearbell ask -a "Yes,No" "<question>"` and use the printed reply.
```

## Develop

```bash
npm test                     # daemon and phone core on a local HyperDHT testnet
npm run fake-phone -- pair <code>   # a phone stand-in in Node, on the real DHT
npm run fake-phone           # listen; type a reply and press Enter
```

`FAKE_PHONE_AUTO=yes npm run fake-phone` answers every question at once.

### Layout

- [shared/](shared): code for both sides. [phone.js](shared/phone.js) is the phone core (links, message store); [protocol.js](shared/protocol.js) has the wire frames and pairing codes; [lines.js](shared/lines.js) frames JSON over streams.
- [cli/](cli): [bin.js](cli/bin.js) (commands), [daemon.js](cli/daemon.js) (HyperDHT server and queue), [control.js](cli/control.js) (local socket, daemon auto-start).
- [android/](android): Kotlin app. [app.js](android/app/src/main/js/app.js) is the Bare worklet entry, bundled with `bare-pack` and linked with `bare-link` during the Gradle build. [BellService.kt](android/app/src/main/java/dev/pearbell/BellService.kt) is a foreground service that keeps the worklet alive and talks to it over Bare Kit IPC.

## Limits

- **Android only** for now. The phone core is plain Bare JavaScript, so an iOS app could reuse it. But iOS does not let apps keep a connection open in the background, so it would need a push service.
- **The computer must be on** with the daemon running. After a reboot, the daemon starts with your next `pearbell` command, and the phone finds it within 30 seconds.
- **Two strict NATs** (for example, both sides on carrier networks) can still fail to connect. A computer on a home or office network is fine.
- **Battery.** The app holds one idle encrypted connection per computer. That costs little, but it is not free.
