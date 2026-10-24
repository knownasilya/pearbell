import test from 'brittle'
import { decide, awayReason, idleSeconds, snoozeReason } from '../cli/router.js'

const now = 1_000_000
const here = { idle: 3, at: now }
const phone = { connected: true }

test('router: no menu bar app means the phone', (t) => {
  const r = decide({ presence: null, phones: [phone], now })
  t.is(r.to, 'phone')
})

test('router: at the Mac means the Mac', (t) => {
  t.is(decide({ presence: here, phones: [phone], now }).to, 'mac')
  t.is(decide({ presence: here, phones: [phone], now }).escalateAfter, null, 'notifications do not move on')
  t.is(decide({ wantsReply: true, presence: here, phones: [phone], now }).escalateAfter, 180_000, 'questions do')
  t.is(decide({ wantsReply: true, presence: { ...here, escalateAfter: 0 }, phones: [phone], now }).escalateAfter, null, '0 turns it off')
})

test('router: idle, locked or asleep means the phone', (t) => {
  t.is(decide({ presence: { idle: 600, at: now }, phones: [phone], now }).to, 'phone')
  t.is(decide({ presence: { ...here, locked: true }, phones: [phone], now }).to, 'phone')
  t.is(decide({ presence: { ...here, asleep: true }, phones: [phone], now }).to, 'phone')
  t.is(decide({ presence: { idle: 40, idleAfter: 30, at: now }, phones: [phone], now }).to, 'phone', 'custom idle threshold')
  t.is(decide({ presence: { idle: 40, at: now }, phones: [phone], now }).to, 'mac')
})

test('router: idle time counts on between reports', (t) => {
  const p = { idle: 280, at: now }
  t.is(idleSeconds(p, now + 30_000), 310)
  t.ok(awayReason(p, now + 30_000))
  t.absent(awayReason(p, now))
})

test('router: away with no phone online shows it on both', (t) => {
  const r = decide({ presence: { ...here, locked: true }, phones: [{ connected: false }], now })
  t.is(r.to, 'both')
  t.ok(r.reason.includes('no phone is online'))
})

test('router: no phone paired means the Mac, even when away', (t) => {
  t.is(decide({ presence: { ...here, locked: true }, phones: [], now }).to, 'mac')
})

test('router: modes and explicit routes', (t) => {
  t.is(decide({ presence: { ...here, mode: 'phone' }, phones: [phone], now }).to, 'phone')
  t.is(decide({ presence: { ...here, locked: true, mode: 'mac' }, phones: [phone], now }).to, 'mac')
  t.is(decide({ route: 'phone', presence: here, phones: [phone], now }).to, 'phone')
  t.is(decide({ route: 'mac', presence: { ...here, locked: true }, phones: [phone], now }).to, 'mac')
  t.is(decide({ route: 'mac', presence: null, phones: [phone], now }).to, 'phone', 'no app to show it')
  t.is(decide({ route: 'all', presence: here, phones: [phone], now }).to, 'both')
})

test('router: snoozed means the phone until it runs out', (t) => {
  const p = { ...here, mode: 'mac', snoozedUntil: now + 3600_000 }
  const r = decide({ presence: p, phones: [phone], now })
  t.is(r.to, 'phone')
  t.ok(r.reason.startsWith('snoozed until '))
  t.is(decide({ presence: p, phones: [phone], now: now + 3600_001 }).to, 'mac', 'over')
  t.absent(snoozeReason({ ...here, snoozedUntil: now - 1 }, now))
})
