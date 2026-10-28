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

test('clear all and undo', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const ids = []
  for (const body of ['one', 'two', 'three']) {
    const entry = daemon.send({ message: { body, actions: [], wantsReply: false }, targets: [device] })
    await once(entry, 'delivered')
    ids.push(entry.id)
  }

  t.is(phone.deleteAll([ids[0], ids[1], 'nope']), 2)
  t.absent(phone.findMessage(ids[0]))
  t.absent(phone.findMessage(ids[1]))
  t.is(phone.findMessage(ids[2]).body, 'three', 'the rest stays')

  t.is(phone.undeleteAll(), 2)
  t.alike(phone.state.messages.map((m) => m.body), ['three', 'two', 'one'], 'back in order')
  t.is(phone.undeleteAll(), 0, 'undo works once')
  t.is(phone.deleteAll([]), 0)
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

test('say reaches a listener on the topic and the phone hears how many', async (t) => {
  const { daemon, phone, events, device } = await setup(t)

  const said = []
  const stop = daemon.listen(['builds'], (f) => said.push(f))
  t.teardown(stop)

  t.is(phone.say('builds', 'How is it going?'), null, 'no computer sent anything under the topic yet')

  const entry = daemon.send({ message: { title: '', topic: 'builds', body: 'Started', actions: [], wantsReply: false }, targets: [device] })
  await once(entry, 'delivered')

  const msg = phone.say('builds', '  How is it going?  ')
  t.ok(msg.mine)
  t.is(msg.body, 'How is it going?')
  t.alike(msg.to.map((x) => x.name), ['laptop'])
  t.is(msg.to[0].heard, null)

  await waitFor(() => said.length === 1)
  const { at, ...rest } = said[0]
  t.alike(rest, { type: 'said', id: msg.id, topic: 'builds', text: 'How is it going?', device: 'pixel' })
  t.ok(at > 0)

  await waitFor(() => phone.findMessage(msg.id).to[0].heard === 1)
  t.ok(events.some((e) => e.type === 'updated' && e.message.id === msg.id && e.message.to[0].heard === 1))
  t.absent(events.some((e) => e.type === 'message' && e.message.mine), 'no notification for your own message')
})

test('say with nobody listening waits, and the phone hears when a session takes it', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const entry = daemon.send({ message: { title: '', topic: 'kody', body: 'hi', actions: [], wantsReply: false }, targets: [device] })
  await once(entry, 'delivered')
  daemon.listen(['other'], () => t.fail('wrong topic'))

  const msg = phone.say('kody', 'Status?')
  await waitFor(() => phone.findMessage(msg.id).to[0].heard === 0)
  t.ok(phone.findMessage(msg.id).to[0].queued, 'waits in the inbox')

  t.is(daemon.takeInbox('kody').length, 1)
  await waitFor(() => phone.findMessage(msg.id).to[0].heard === 1)
  t.absent(phone.findMessage(msg.id).to[0].queued, 'a session took it')
})

test('say waits for the computer and goes out on reconnect', async (t) => {
  const { daemon, phone, device } = await setup(t)

  const entry = daemon.send({ message: { title: '', topic: 'ci', body: 'hi', actions: [], wantsReply: false }, targets: [device] })
  await once(entry, 'delivered')

  const said = []
  daemon.listen(['ci'], (f) => said.push(f))
  daemon.conns.get(device.publicKey).destroy()
  await waitFor(() => !phone.snapshot().peers[0].connected)

  const msg = phone.say('ci', 'Still going?')
  await waitFor(() => phone.findMessage(msg.id).to[0].heard === 1)
  t.is(said.length, 1)
})

test('a repeated say is not passed on twice', async (t) => {
  const daemon = new Daemon({ dht: null, keyPair: DHT.keyPair(), name: 'laptop' })
  const device = { publicKey: 'ab', name: 'pixel' }
  const frames = []
  const conn = { destroyed: false, write: (buf) => frames.push(JSON.parse(buf.toString())) }
  const said = []
  daemon.listen(['ci', 'other'], (f) => said.push(f))
  daemon.listen(['ci'], (f) => said.push(f))

  daemon._onsay(device, conn, { type: 'say', id: 's1', topic: ' ci ', text: 'Status?' })
  daemon._onsay(device, conn, { type: 'say', id: 's1', topic: 'ci', text: 'Status?' })
  daemon._onsay(device, conn, { type: 'say', id: 's2', topic: '', text: 'x' })

  t.is(said.length, 2, 'both listeners, once')
  t.alike(frames, [{ type: 'heard', id: 's1', listeners: 2, queued: false }, { type: 'heard', id: 's1', listeners: 2, queued: false }])
})

test('a say nobody listens to waits in the inbox until a session takes it', async (t) => {
  const daemon = new Daemon({ dht: null, keyPair: DHT.keyPair(), name: 'laptop' })
  const device = { publicKey: 'ab', name: 'pixel' }
  const frames = []
  const conn = { destroyed: false, write: (buf) => frames.push(JSON.parse(buf.toString())) }
  daemon.conns.set('ab', conn)

  daemon._onsay(device, conn, { type: 'say', id: 's1', topic: 'ci', text: 'Status?' })
  t.alike(frames.pop(), { type: 'heard', id: 's1', listeners: 0, queued: true })
  t.alike(daemon.takeInbox('other'), [])

  const taken = daemon.takeInbox('ci')
  t.is(taken.length, 1)
  t.is(taken[0].text, 'Status?')
  t.is(taken[0].device, 'pixel')
  t.absent('from' in taken[0], 'the phone key stays inside')
  t.alike(frames.pop(), { type: 'heard', id: 's1', listeners: 1 }, 'the phone hears a session took it')
  t.alike(daemon.takeInbox('ci'), [], 'taken once')

  daemon._onsay(device, conn, { type: 'say', id: 's1', topic: 'ci', text: 'Status?' })
  t.alike(frames.pop(), { type: 'heard', id: 's1', listeners: 1, queued: false }, 'a resend after that says heard')
  t.alike(daemon.takeInbox('ci'), [])
})

test('the menu bar app hears when a session takes what it queued', async (t) => {
  const daemon = new Daemon({ dht: null, keyPair: DHT.keyPair(), name: 'laptop' })
  const frames = []
  const conn = { destroyed: false, write: (buf) => frames.push(JSON.parse(buf.toString())) }
  daemon.mac = { conn, presence: {} }
  daemon.onMacFrame(conn, { type: 'say', id: 'm1', topic: 'ci', text: 'Status?' })
  t.alike(frames.pop(), { type: 'heard', id: 'm1', listeners: 0, queued: true })
  t.is(daemon.takeInbox('ci')[0].device, 'this Mac')
  t.alike(frames.pop(), { type: 'heard', id: 'm1', listeners: 1 })
})

test('a new listener gets what waited in the inbox; old ones expire', async (t) => {
  const daemon = new Daemon({ dht: null, keyPair: DHT.keyPair(), name: 'laptop' })
  const device = { publicKey: 'ab', name: 'pixel' }
  const conn = { destroyed: false, write: () => {} }

  daemon._onsay(device, conn, { type: 'say', id: 'old', topic: 'ci', text: 'Old' })
  daemon.inbox.get('ci')[0].at -= 2 * 60 * 60 * 1000
  daemon._onsay(device, conn, { type: 'say', id: 'new', topic: 'ci', text: 'New' })

  const said = []
  daemon.listen(['ci'], (f) => said.push(f))
  t.alike(said.map((f) => f.id), ['new'])
  t.alike(daemon.takeInbox('ci'), [])
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
