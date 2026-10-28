// The menu bar app's side of the daemon, over the real local socket.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'brittle'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import { Phone } from '../shared/phone.js'
import { onJSON, writeJSON } from '../shared/lines.js'
import { Daemon } from '../cli/daemon.js'
import * as control from '../cli/control.js'

const AT_DESK = { idle: 1, mode: 'auto' }

async function setup (t, { pair = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'))
  process.env.PEARBELL_HOME = home
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }), { order: Infinity })

  const testnet = await createTestnet(3, t.teardown)
  const node = () => {
    const dht = new DHT({ bootstrap: testnet.bootstrap })
    t.teardown(() => dht.destroy(), { order: Infinity })
    return dht
  }

  const daemon = new Daemon({ dht: node(), keyPair: DHT.keyPair(), name: 'laptop' })
  await daemon.start()
  t.teardown(() => daemon.stop())
  const server = await control.serve(daemon)
  t.teardown(() => server.closeAll())

  const phoneMessages = []
  let phone = null
  let device = null
  if (pair) {
    phone = new Phone({ dht: node(), name: 'pixel', emit: (e) => e.type === 'message' && phoneMessages.push(e.message) })
    phone.start()
    t.teardown(() => phone.stop())
    const { code, done } = daemon.startPairing(10_000)
    await phone.pair(code)
    device = await done
    await waitFor(() => daemon.isConnected(device.publicKey))
  }

  return { daemon, phone, device, phoneMessages }
}

// A stand-in for the Swift app: connects, reports presence, acks messages.
async function connectMac (t, presence = AT_DESK) {
  const sock = net.connect(control.socketPath())
  await new Promise((resolve) => sock.once('connect', resolve))
  t.teardown(() => sock.destroy())

  const mac = { sock, frames: [], messages: [] }
  onJSON(sock, (f) => {
    mac.frames.push(f)
    if (f.type === 'msg') {
      mac.messages.push(f)
      writeJSON(sock, { type: 'ack', id: f.id })
    }
  })
  mac.presence = (p) => writeJSON(sock, { type: 'presence', ...p })
  mac.reply = (id, text) => writeJSON(sock, { type: 'reply', id, text })
  writeJSON(sock, { type: 'mac', presence })
  await waitFor(() => mac.frames.find((f) => f.type === 'state'))
  return mac
}

test('mac: at the desk, a notification shows on the Mac only', async (t) => {
  const { daemon, device, phoneMessages } = await setup(t)
  const mac = await connectMac(t)
  t.is(mac.frames[0].devices[0].name, 'pixel', 'the app hears about the phones')

  const entry = daemon.send({ message: { body: 'Build done', actions: [], wantsReply: false }, targets: [device] })
  t.is(entry.route.to, 'mac')
  const d = await once(entry, 'delivered')
  t.is(d.name, 'this Mac')

  const msg = mac.messages[0]
  t.is(msg.body, 'Build done')
  t.is(msg.notify, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(phoneMessages.length, 0, 'the phone stays quiet')
})

test('mac: away from the desk, it goes to the phone and the Mac keeps a quiet copy', async (t) => {
  const { daemon, device, phoneMessages } = await setup(t)
  const mac = await connectMac(t, { idle: 900 })

  const entry = daemon.send({ message: { body: 'Build done', actions: [], wantsReply: false }, targets: [device] })
  t.is(entry.route.to, 'phone')
  t.is((await once(entry, 'delivered')).name, 'pixel')
  await waitFor(() => mac.messages.length)
  t.is(mac.messages[0].notify, false)
  t.is(phoneMessages.length, 1)
})

test('mac: a question moves to the phone when you step away, and an answer closes it everywhere', async (t) => {
  const { daemon, device, phone, phoneMessages } = await setup(t)
  const mac = await connectMac(t)

  const entry = daemon.send({ message: { body: 'Deploy?', actions: ['Yes', 'No'], wantsReply: true }, targets: [device] })
  t.is(entry.route.to, 'mac')
  await waitFor(() => mac.messages.length)

  const routed = once(entry, 'routed')
  mac.presence({ idle: 0, locked: true })
  const r = await routed
  t.is(r.to, 'both')
  t.is(r.reason, 'the screen is locked')
  await waitFor(() => mac.frames.find((f) => f.type === 'routed'))

  const msg = await waitFor(() => phoneMessages[0])
  const replied = once(entry, 'reply')
  phone.answer(msg.id, 'Yes')
  t.is((await replied).device.name, 'pixel')

  const closed = await waitFor(() => mac.frames.find((f) => f.type === 'closed'))
  t.is(closed.answer, 'Yes')
  t.is(closed.device, 'pixel')
})

test('mac: answering on the Mac closes the question on the phone', async (t) => {
  const { daemon, device, phone } = await setup(t)
  const mac = await connectMac(t)

  const entry = daemon.send({ message: { body: 'Deploy?', actions: [], wantsReply: true }, targets: [device], route: 'all' })
  t.is(entry.route.to, 'both')
  await waitFor(() => mac.messages.length && phone.findMessage(entry.id))

  const replied = once(entry, 'reply')
  mac.reply(entry.id, 'Ship it')
  const { text, device: from } = await replied
  t.is(text, 'Ship it')
  t.is(from.name, 'this Mac')
  await waitFor(() => phone.findMessage(entry.id).closed)
  t.pass('phone closed it')
})

test('mac: a message you do not see on the Mac follows you to the phone', async (t) => {
  const { daemon, device, phoneMessages } = await setup(t)
  const mac = await connectMac(t, { idle: 0, idleAfter: 300 })

  const entry = daemon.send({ message: { body: 'Tests passed', actions: [], wantsReply: false }, targets: [device] })
  t.is(entry.route.to, 'mac')
  await once(entry, 'delivered')
  await new Promise((resolve) => setTimeout(resolve, 50))

  const routed = once(entry, 'routed')
  mac.presence({ idle: 300, idleAfter: 300 })
  const r = await routed
  t.is(r.to, 'both')
  t.is(r.reason, 'not seen on the Mac, the Mac has been idle for 5 min')
  t.is((await once(entry, 'delivered')).name, 'pixel')
  await waitFor(() => phoneMessages.length)
  t.absent(daemon.messages.has(entry.id), 'done once the phone has it')
})

test('mac: a message stays on the Mac once you touch the Mac after it showed', async (t) => {
  const { daemon, device, phoneMessages } = await setup(t)
  const mac = await connectMac(t, { idle: 0, idleAfter: 300 })

  const entry = daemon.send({ message: { body: 'Tests passed', actions: [], wantsReply: false }, targets: [device] })
  await once(entry, 'delivered')
  t.ok(daemon.messages.has(entry.id), 'kept until you touch the Mac')
  await new Promise((resolve) => setTimeout(resolve, 1100))

  mac.presence({ idle: 0, idleAfter: 300 })
  await waitFor(() => !daemon.messages.has(entry.id))
  mac.presence({ idle: 0, locked: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(phoneMessages.length, 0, 'the phone stays quiet')
})

test('mac: an unanswered question escalates after escalateAfter', async (t) => {
  const { daemon, device, phoneMessages } = await setup(t)
  await connectMac(t, { idle: 0, escalateAfter: 1 })

  const entry = daemon.send({ message: { body: 'Still there?', actions: [], wantsReply: true }, targets: [device] })
  t.is(entry.route.to, 'mac')
  const r = await once(entry, 'routed')
  t.is(r.reason, 'no answer on the Mac yet')
  await waitFor(() => phoneMessages.length)
  t.pass('reached the phone')
})

test('mac: quitting the app hands open questions to the phone', async (t) => {
  const { daemon, device, phoneMessages } = await setup(t)
  const mac = await connectMac(t)

  const entry = daemon.send({ message: { body: 'Merge?', actions: [], wantsReply: true }, targets: [device] })
  await waitFor(() => mac.messages.length)
  mac.sock.destroy()

  const r = await once(entry, 'routed')
  t.is(r.reason, 'the menu bar app quit')
  await waitFor(() => phoneMessages.length)
  t.absent(daemon.mac)
})

test('mac: works with no phone paired', async (t) => {
  const { daemon } = await setup(t, { pair: false })
  await connectMac(t, { idle: 0, locked: true })

  const entry = daemon.send({ message: { body: 'Hi', actions: [], wantsReply: false }, targets: [] })
  t.is(entry.route.to, 'mac')
  await once(entry, 'delivered')
  t.absent(daemon.messages.has(entry.id))
})

test('mac: the CLI request reports the route', async (t) => {
  await setup(t)
  await connectMac(t)

  const sock = await control.connect({ start: false })
  const frames = []
  await control.request(sock, { type: 'send', message: { body: 'hello' } }, (f) => {
    frames.push(f)
    if (f.type === 'delivered') sock.end()
  })
  t.is(frames[0].type, 'queued')
  t.is(frames[0].route, 'mac')
  t.alike(frames[0].targets, ['this Mac'])
  t.is(frames[1].device, 'this Mac')
})

test('mac: the app gets the id and updates', async (t) => {
  const { daemon, device } = await setup(t)
  const mac = await connectMac(t)

  const first = daemon.send({ message: control.sanitize({ body: '- [ ] one', key: 'list' }), targets: [device] })
  await once(first, 'delivered')
  const next = daemon.send({ message: control.sanitize({ body: '- [x] one', key: 'list', update: true }), targets: [device] })
  await once(next, 'delivered')

  t.is(mac.messages[0].key, 'list')
  t.absent(mac.messages[0].update)
  t.is(mac.messages[1].key, 'list')
  t.is(mac.messages[1].update, true)
  t.is(mac.messages[1].body, '- [x] one')
})

test('mac: the app writes to a topic, and hears how many listened', async (t) => {
  const { daemon } = await setup(t, { pair: false })
  const mac = await connectMac(t)
  const said = []
  daemon.listen(['builds'], (f) => said.push(f))

  writeJSON(mac.sock, { type: 'say', id: 'm1', topic: 'builds', text: ' Status? ' })
  writeJSON(mac.sock, { type: 'say', id: 'm2', topic: 'kody', text: 'Status?' })
  await waitFor(() => mac.frames.filter((f) => f.type === 'heard').length === 2)

  t.alike(said, [{ type: 'said', id: 'm1', topic: 'builds', text: 'Status?', device: 'this Mac' }])
  t.alike(mac.frames.filter((f) => f.type === 'heard'), [
    { type: 'heard', id: 'm1', listeners: 1 },
    { type: 'heard', id: 'm2', listeners: 0 }
  ])
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
