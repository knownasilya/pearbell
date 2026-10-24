// Decides where a message goes: the Mac (the menu bar app in macos/), the
// phone, or both.
//
// The menu bar app keeps a connection to the daemon and reports presence:
// seconds since the last keyboard or mouse input, whether the screen is
// locked or the Mac is going to sleep, and the routing settings from its menu.
// The rules, first match wins:
//
//   1. An explicit route (--to mac|phone|all, or -d <phone>) is followed.
//   2. No menu bar app: the phone, as before.
//   3. No phone paired: the Mac.
//   4. The menu says "Always Mac" or "Always phone": that one.
//   5. Mac asleep or screen locked: the phone.
//   6. No input for idleAfter seconds (default 5 min): the phone.
//   7. Otherwise you are at the Mac, so the Mac. A question there also goes
//      to the phone if it is still open after escalateAfter seconds (default
//      3 min), or as soon as you step away (the daemon watches presence).
//
// When the phone wins but none is online, the Mac shows it too, so the
// message is waiting on whichever screen you see first.
export const IDLE_AFTER = 300
export const ESCALATE_AFTER = 180

export function decide ({ wantsReply = false, route = 'auto', presence = null, phones = [], now = Date.now() }) {
  const mac = presence !== null
  const online = phones.some((p) => p.connected)
  const pick = (to, reason) => ({
    to: to === 'phone' && !online && mac ? 'both' : to,
    reason: to === 'phone' && !online && mac ? `${reason}, but no phone is online` : reason,
    escalateAfter: null
  })

  if (route === 'phone') return mac ? pick('phone', 'sent to the phone') : { to: 'phone', reason: 'sent to the phone', escalateAfter: null }
  if (route === 'all') return { to: mac ? 'both' : 'phone', reason: 'sent everywhere', escalateAfter: null }
  if (!mac) return { to: 'phone', reason: 'the menu bar app is not running', escalateAfter: null }
  if (!phones.length) return { to: 'mac', reason: 'no phone is paired', escalateAfter: null }
  if (route === 'mac') return { to: 'mac', reason: 'sent to the Mac', escalateAfter: null }

  const mode = presence.mode
  if (mode === 'mac') return { to: 'mac', reason: 'set to Always Mac', escalateAfter: null }
  if (mode === 'phone') return pick('phone', 'set to Always phone')

  const away = awayReason(presence, now)
  if (away) return pick('phone', away)

  const after = seconds(presence.escalateAfter, ESCALATE_AFTER)
  return {
    to: 'mac',
    reason: 'you are using it',
    escalateAfter: wantsReply && after > 0 ? after * 1000 : null
  }
}

// Why the Mac does not count as in use right now, or null if it does.
export function awayReason (presence, now = Date.now()) {
  if (!presence) return 'the menu bar app is not running'
  if (presence.asleep) return 'the Mac is asleep'
  if (presence.locked) return 'the screen is locked'

  const idle = idleSeconds(presence, now)
  if (idle >= seconds(presence.idleAfter, IDLE_AFTER)) return `the Mac has been idle for ${duration(idle)}`
  return null
}

// The app reports idle time every few seconds; count on from the last report.
export function idleSeconds (presence, now = Date.now()) {
  const idle = Number.isFinite(presence.idle) && presence.idle >= 0 ? presence.idle : 0
  return idle + Math.max(0, now - (presence.at || now)) / 1000
}

function seconds (value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function duration (s) {
  if (s < 90) return `${Math.round(s)} s`
  if (s < 90 * 60) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}
