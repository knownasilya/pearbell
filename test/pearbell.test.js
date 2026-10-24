import test from 'brittle'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import { Phone } from '../shared/phone.js'
import { Daemon } from '../cli/daemon.js'
import { clipBody, MAX_BODY } from '../shared/protocol.js'
import { badKey, sanitize } from '../cli/control.js'

async function setup (t) {
  const testnet = await createTestnet(3, t.teardown)
  const node = () => {
    const dht = new DHT({ bootstrap: testnet.bootstrap })
    t.teardown(() => dht.destroy(), { order: Infinity })
    return dht
  }

  const daemon = new Daemon({ dht: node(), keyPair: DHT.keyPair(), name: 'laptop' })
  await daemon.start()
  t.teardown(() => daemon.stop())

  const events = []
  const phone = new Phone({ dht: node(), emit: (e) => events.push(e) })
  phone.start()
  t.teardown(() => phone.stop())

  const { code, done } = daemon.startPairing(10_000)
  await phone.pair(code, 'pixel')
  const device = await done
  await waitFor(() => daemon.isConnected(device.publicKey))

  return { daemon, phone, events, device, node }
}

test('pairing stores both sides and the phone connects', async (t) => {
  const { daemon, phone, device } = await setup(t)

  t.is(device.name, 'pixel')
  t.is(device.publicKey, phone.publicKey.toString('hex'))
  t.is(daemon.devices.length, 1)
  t.is(phone.state.peers.length, 1)
  t.is(phone.state.peers[0].name, 'laptop')
  t.ok(phone.snapshot().peers[0].connected)
})

test('the phone picks up a renamed computer', async (t) => {
  const { daemon, phone, device } = await setup(t)

  daemon.name = 'Studio Mac'
  daemon.conns.get(device.publicKey).destroy()

  await waitFor(() => phone.state.peers[0].name === 'Studio Mac')
  t.pass('name updated on reconnect')
})

test('wrong pairing token is refused', async (t) => {
  const { daemon, phone } = await setup(t)

  const { code, done } = daemon.startPairing(10_000)
  done.catch(() => {})
  const forged = code.slice(0, -4) + (code.endsWith('0000') ? '1111' : '0000')

  await t.exception(phone.pair(forged, 'pixel'), /Wrong pairing code/)
  t.is(daemon.devices.length, 1)
})

test('send delivers a notification', async (t) => {
  const { daemon, events, device } = await setup(t)

  const entry = daemon.send({
    message: { title: 'Build', body: 'Tests passed', actions: [], wantsReply: false },
    targets: [device]
  })
  await once(entry, 'delivered')

  const msg = events.find((e) => e.type === 'message').message
  t.is(msg.title, 'Build')
  t.is(msg.body, 'Tests passed')
  t.is(msg.fromName, 'laptop')
  t.absent(daemon.messages.has(entry.id), 'delivered messages leave the queue')
})

test('ask gets the reply and the phone hears it is closed', async (t) => {
  const { daemon, phone, events, device } = await setup(t)

  const entry = daemon.send({
    message: { title: '', body: 'Deploy?', actions: ['Yes', 'No'], wantsReply: true },
    targets: [device]
  })

  const msg = await waitFor(() => events.find((e) => e.type === 'message')?.message)
  t.alike(msg.actions, ['Yes', 'No'])

  const replied = once(entry, 'reply')
  t.ok(phone.answer(msg.id, 'Yes'))
  const { text } = await replied
  t.is(text, 'Yes')

  await waitFor(() => phone.findMessage(msg.id).closed)
  t.pass('phone marked it closed')
})

test('messages queue while the phone is offline', async (t) => {
  const { daemon, phone, events, device } = await setup(t)

  await phone.stop()
  await waitFor(() => !daemon.isConnected(device.publicKey))

  const entry = daemon.send({ message: { body: 'while you were away', actions: [], wantsReply: false }, targets: [device] })
  const delivered = once(entry, 'delivered')

  phone.start()
  await delivered
  t.ok(events.find((e) => e.type === 'message' && e.message.body === 'while you were away'))
})

test('a reply given offline is sent when the link comes back', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const entry = daemon.send({ message: { body: 'Continue?', actions: [], wantsReply: true }, targets: [device] })
  await once(entry, 'delivered')

  await phone.stop()
  await waitFor(() => !daemon.isConnected(device.publicKey))
  t.ok(phone.answer(entry.id, 'later answer'))

  const replied = once(entry, 'reply')
  phone.start()
  const { text } = await replied
  t.is(text, 'later answer')
  t.is(phone.state.messages.length, 1, 'no duplicate message')
})

test('closing an unanswered question tells the phone', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const entry = daemon.send({ message: { body: 'Still there?', actions: [], wantsReply: true }, targets: [device] })
  await once(entry, 'delivered')
  daemon.close(entry.id)

  await waitFor(() => phone.findMessage(entry.id).closed)
  t.absent(phone.answer(entry.id, 'too late'))
})

test('questions lost in a daemon restart get closed on reconnect', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const entry = daemon.send({ message: { body: 'Lost?', actions: [], wantsReply: true }, targets: [device] })
  await once(entry, 'delivered')

  // Simulate a crash: the daemon forgets without telling anyone.
  clearTimeout(entry.timer)
  daemon.messages.delete(entry.id)
  daemon.conns.get(device.publicKey).destroy()

  await waitFor(() => phone.findMessage(entry.id).closed)
  t.pass('phone closed the orphaned question')
})

test('archive, delete and undo', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const entry = daemon.send({ message: { body: 'Keep me', actions: [], wantsReply: false }, targets: [device] })
  await once(entry, 'delivered')
  const id = entry.id

  t.ok(phone.archive(id))
  t.is(phone.findMessage(id).archived, true)
  t.ok(phone.archive(id, false))
  t.is(phone.findMessage(id).archived, false)

  t.ok(phone.delete(id))
  t.absent(phone.findMessage(id))
  t.ok(phone.undelete(id))
  t.is(phone.findMessage(id).body, 'Keep me')
  t.absent(phone.undelete(id), 'undo works once')
})

test('the computer picks up a renamed phone', async (t) => {
  const { daemon, phone, device } = await setup(t)

  phone.setName('Work phone')
  await waitFor(() => daemon.findDevice(device.publicKey).name === 'Work phone')
  t.pass('rename sent on the open link')

  // A rename while offline arrives with the next hello.
  phone.name = 'Pocket'
  daemon.conns.get(device.publicKey).destroy()
  await waitFor(() => daemon.findDevice(device.publicKey).name === 'Pocket')
  t.pass('name sent on reconnect')
})

test('topics and long messages reach the phone whole', async (t) => {
  const { daemon, events, device } = await setup(t)
  const long = 'x'.repeat(15_000)

  const entry = daemon.send({ message: { topic: 'github-daily', title: 'Daily', body: long, actions: [], wantsReply: false }, targets: [device] })
  await once(entry, 'delivered')

  const msg = events.find((e) => e.type === 'message').message
  t.is(msg.topic, 'github-daily')
  t.is(msg.body.length, 15_000, 'no truncation under the 16000 limit')
})

test('an over-long body is cut with a note, never silently', (t) => {
  t.is(clipBody('short'), 'short')
  t.is(clipBody('x'.repeat(MAX_BODY)).length, MAX_BODY, 'the limit itself fits')

  const cut = clipBody('x'.repeat(20_000))
  t.ok(cut.length <= MAX_BODY)
  t.ok(cut.endsWith(`… (cut: ${(20_000 - (MAX_BODY - 64)).toLocaleString('en-US')} more characters)`))
})

test('an update edits the message with that id, quietly', async (t) => {
  const { daemon, phone, events, device } = await setup(t)

  const first = daemon.send({ message: sanitize({ title: 'Release', body: '- [ ] tests\n- [ ] ship', key: 'rel-1' }), targets: [device] })
  await once(first, 'delivered')
  const original = phone.findByKey(phone.state.peers[0].publicKey, 'rel-1')
  t.is(original.key, 'rel-1')
  t.is(original.updatedAt, null)

  const next = daemon.send({ message: sanitize({ body: '- [x] tests\n- [ ] ship', key: 'rel-1', update: true }), targets: [device] })
  await once(next, 'delivered')

  t.is(phone.state.messages.length, 1, 'no new message')
  const msg = phone.findMessage(original.id)
  t.is(msg.body, '- [x] tests\n- [ ] ship')
  t.is(msg.title, 'Release', 'an update without a title keeps it')
  t.ok(msg.updatedAt)
  t.is(msg.updates, 1)
  t.is(events.filter((e) => e.type === 'message').length, 1, 'no second notification')
  t.ok(events.find((e) => e.type === 'edited' && e.message.id === original.id))
})

test('an update for an unknown id shows as a new message', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const entry = daemon.send({ message: sanitize({ title: 'Late', body: 'step 2 of 3', key: 'job', update: true }), targets: [device] })
  await once(entry, 'delivered')
  t.is(phone.state.messages.length, 1)
  t.is(phone.state.messages[0].key, 'job')
  t.is(phone.state.messages[0].body, 'step 2 of 3')
})

test('message ids are checked and updates never ask', (t) => {
  t.is(badKey(undefined, false), null)
  t.ok(badKey(undefined, true))
  t.ok(badKey('has space', false))
  t.ok(badKey('x'.repeat(65), false))
  t.is(badKey('deploy-42', true), null)

  const m = sanitize({ body: 'x', key: ' k ', update: true, wantsReply: true, actions: ['a'] })
  t.is(m.key, 'k')
  t.is(m.update, true)
  t.is(m.wantsReply, false)
  t.alike(m.actions, [])
  t.absent('key' in sanitize({ body: 'x' }))
})

test('unknown keys cannot connect', async (t) => {
  const { daemon, node } = await setup(t)

  const stranger = new Phone({ dht: node() })
  stranger.state.peers.push({ publicKey: daemon.keyPair.publicKey.toString('hex'), name: 'x' })
  stranger.start()
  t.teardown(() => stranger.stop())

  await new Promise((resolve) => setTimeout(resolve, 1500))
  t.absent(daemon.isConnected(stranger.publicKey.toString('hex')))
})

function once (emitter, name) {
  return new Promise((resolve) => emitter.once(name, resolve))
}

async function waitFor (fn, timeout = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}
