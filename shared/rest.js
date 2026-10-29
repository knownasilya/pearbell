// Rest hours: a bedtime window every night, and rest days (Sunday unless you
// pick others). While you rest, messages still arrive and wait in the inbox,
// but they make no sound and show no banner, on the phone and on the Mac.
//
// It is one setting for all your devices. The daemon keeps it in config.json
// and passes it on: a change on the phone, on the Mac or from pearbell rest
// reaches the others. Each device decides by its own clock whether it is
// resting now. The newest change wins (updatedAt).
//
//   { on, nightly, from: 'HH:MM', until: 'HH:MM', days: [0..6], updatedAt }
//
// days are JavaScript weekdays: 0 is Sunday. A night that starts before a rest
// day runs into it, and one that starts on a rest day runs out of it.
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export const DEFAULT_REST = Object.freeze({
  on: false,
  nightly: true,
  from: '22:00',
  until: '07:00',
  days: [0],
  updatedAt: 0
})

export function cleanRest (rest) {
  const r = rest && typeof rest === 'object' ? rest : {}
  const days = Array.isArray(r.days) ? r.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULT_REST.days
  return {
    on: r.on === true,
    nightly: r.nightly !== false,
    from: cleanTime(r.from) ?? DEFAULT_REST.from,
    until: cleanTime(r.until) ?? DEFAULT_REST.until,
    days: [...new Set(days)].sort(),
    updatedAt: Number.isFinite(r.updatedAt) && r.updatedAt > 0 ? r.updatedAt : 0
  }
}

// "7:30" or "07:30" as "07:30", or null.
export function cleanTime (value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof value === 'string' ? value.trim() : '')
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

// Whether messages should be quiet at this moment, by the device's clock.
export function resting (rest, date = new Date()) {
  if (!rest || !rest.on) return false
  if (rest.days.includes(date.getDay())) return true
  if (!rest.nightly) return false

  const now = date.getHours() * 60 + date.getMinutes()
  const from = minutes(rest.from)
  const until = minutes(rest.until)
  if (from === until) return false
  return from < until ? now >= from && now < until : now >= from || now < until
}

// When resting ends, or null when it does not end (every day a rest day) or
// you are not resting.
export function restEnds (rest, date = new Date()) {
  if (!resting(rest, date)) return null
  const t = new Date(date)
  t.setSeconds(0, 0)
  for (let i = 0; i < 8 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1)
    if (!resting(rest, t)) return t
  }
  return null
}

// "Sun", "Sat, Sun", or "" for no rest day.
export function daysText (days) {
  // Monday first, the way a week reads.
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d))
    .map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1)).join(', ')
}

// One line for pearbell rest and the daemon log.
export function restText (rest, date = new Date()) {
  if (!rest.on) return 'off'
  const parts = []
  if (rest.nightly && rest.from !== rest.until) parts.push(`nights ${rest.from}–${rest.until}`)
  if (rest.days.length) parts.push(`all day ${daysText(rest.days)}`)
  if (!parts.length) return 'on, but no hours picked'
  const ends = restEnds(rest, date)
  const now = resting(rest, date)
    ? ends ? `, resting until ${ends.toDateString() === date.toDateString() ? '' : DAYS[ends.getDay()] + ' '}${hhmm(ends)}` : ', resting'
    : ''
  return parts.join(', ') + now
}

function minutes (time) {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function hhmm (date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
