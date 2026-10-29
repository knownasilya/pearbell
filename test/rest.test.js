import test from 'brittle'
import { DEFAULT_REST, cleanRest, cleanTime, restEnds, restText, resting } from '../shared/rest.js'

// Local time, so the tests read like a clock. 2026-11-01 is a Sunday.
const at = (day, time) => {
  const [h, m] = time.split(':').map(Number)
  return new Date(2026, 10, day, h, m)
}
const on = cleanRest({ ...DEFAULT_REST, on: true })

test('rest: off by default, with nights 22:00 to 07:00 and Sunday ready', (t) => {
  const r = cleanRest(undefined)
  t.is(r.on, false)
  t.is(r.from, '22:00')
  t.is(r.until, '07:00')
  t.alike(r.days, [0])
  t.absent(resting(r, at(1, '12:00')), 'off means never')
})

test('rest: nights cross midnight', (t) => {
  t.ok(resting(on, at(3, '22:00')), 'Tuesday at bedtime')
  t.ok(resting(on, at(4, '06:59')), 'Wednesday before getting up')
  t.absent(resting(on, at(4, '07:00')), 'up at 7')
  t.absent(resting(on, at(4, '21:59')))
})

test('rest: a moved bedtime, and one that does not cross midnight', (t) => {
  const late = cleanRest({ ...on, from: '23:30', until: '6:15' })
  t.absent(resting(late, at(3, '23:00')))
  t.ok(resting(late, at(3, '23:30')))
  t.ok(resting(late, at(4, '06:14')))
  const nap = cleanRest({ ...on, from: '13:00', until: '14:00', days: [] })
  t.ok(resting(nap, at(3, '13:30')))
  t.absent(resting(nap, at(3, '14:00')))
  t.absent(resting(cleanRest({ ...on, until: '22:00' }), at(3, '23:00')), 'same start and end: no nights')
})

test('rest: Sunday is a rest day, all day, and the night runs into Monday', (t) => {
  t.ok(resting(on, at(1, '00:00')))
  t.ok(resting(on, at(1, '12:00')))
  t.ok(resting(on, at(2, '06:00')), 'Monday before 7')
  t.absent(resting(on, at(2, '08:00')))
  t.absent(resting(cleanRest({ ...on, days: [] }), at(1, '12:00')), 'no rest day')
  t.absent(resting(cleanRest({ ...on, nightly: false }), at(3, '23:00')), 'no nights')
})

test('rest: when it ends', (t) => {
  t.alike(restEnds(on, at(3, '23:15')), at(4, '07:00'))
  t.alike(restEnds(on, new Date(2026, 9, 31, 22, 30)), at(2, '07:00'), 'Saturday night runs through Sunday')
  t.is(restEnds(on, at(3, '12:00')), null, 'not resting')
  t.is(restEnds(cleanRest({ ...on, days: [0, 1, 2, 3, 4, 5, 6] }), at(3, '12:00')), null, 'every day')
  t.is(restText(on, at(3, '23:15')), 'nights 22:00–07:00, all day Sun, resting until wed 07:00')
  t.is(restText(on, at(3, '12:00')), 'nights 22:00–07:00, all day Sun')
  t.is(restText(DEFAULT_REST), 'off')
})

test('rest: bad input is cleaned', (t) => {
  t.is(cleanTime('7:05'), '07:05')
  t.is(cleanTime('24:00'), null)
  t.is(cleanTime('noon'), null)
  const r = cleanRest({ on: 'yes', from: 'x', days: [6, 0, 9, 0, 'mon'], updatedAt: -1 })
  t.is(r.on, false)
  t.is(r.from, '22:00')
  t.alike(r.days, [0, 6])
  t.is(r.updatedAt, 0)
})
