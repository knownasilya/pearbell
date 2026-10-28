// The local socket between short-lived CLI commands and the daemon.
// Newline-delimited JSON, one request per connection.
//
// The macOS menu bar app (macos/) keeps one connection open instead:
//   app -> daemon  { type: 'mac', presence }   first frame
//   app -> daemon  { type: 'presence', idle, locked, asleep, mode, idleAfter, escalateAfter }
//   daemon -> app  { type: 'state', computer, devices }
//   daemon -> app  { type: 'msg', id, title, topic, body, actions, wantsReply, key?, update?, notify, route, sentAt }
//   app -> daemon  { type: 'ack', id }  or  { type: 'reply', id, text }
//   app -> daemon  { type: 'say', id, topic, text }   the user wrote to a topic
//   daemon -> app  { type: 'heard', id, listeners }   as for the phone (shared/protocol.js)
//   daemon -> app  { type: 'routed', id, to, reason }   a question moved on to the phone
//   daemon -> app  { type: 'closed', id, answer?, device? }
//   daemon -> app  { type: 'synced', open }   after a (re)connect: questions still open
// key and update work as on the phone (see shared/protocol.js).
// notify says whether the app shows a notification; otherwise it only keeps
// the message in its inbox, because the phone got it.
//
// pearbell mcp --channel and pearbell listen keep one open too, to hear what
// the user writes to a topic on the phone:
//   cli -> daemon  { type: 'listen', topics }
//   daemon -> cli  { type: 'listening', topics }
//   daemon -> cli  { type: 'said', id, topic, text, device, at }
// pearbell inbox takes what nobody listened to yet:
//   cli -> daemon  { type: 'inbox', topic }
//   daemon -> cli  { type: 'inbox', messages: [{ id, topic, text, device, at }] }
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { onJSON, writeJSON } from '../shared/lines.js'
import { cleanKey, clipBody } from '../shared/protocol.js'
import * as config from './config.js'
import { SEND_TTL } from './daemon.js'
import * as service from './service.js'

export const BIN = fileURLToPath(new URL('./bin.js', import.meta.url))

export function socketPath () {
  const hash = createHash('sha256').update(config.home()).digest('hex').slice(0, 12)
  if (process.platform === 'win32') return `\\\\.\\pipe\\pearbell-${hash}`

  // Unix socket paths have a short length limit (about 104 bytes).
  const preferred = path.join(config.home(), 'daemon.sock')
  return preferred.length < 100 ? preferred : path.join(os.tmpdir(), `pearbell-${hash}.sock`)
}

export function logPath () {
  return path.join(config.home(), 'daemon.log')
}

// Daemon side: answer CLI requests.
export async function serve (daemon) {
  const file = socketPath()

  // A socket file without a daemon behind it is left from a crash.
  if (process.platform !== 'win32' && fs.existsSync(file)) {
    if (await reachable(file)) throw new Error('The daemon is already running')
    fs.unlinkSync(file)
  }

  const socks = new Set()
  const server = net.createServer((sock) => {
    socks.add(sock)
    sock.on('close', () => socks.delete(sock))
    sock.on('error', noop)
    onJSON(sock, (req) => handle(daemon, sock, req))
  })

  // Waiting CLI commands would keep the process alive, so hang up on them.
  server.closeAll = () => {
    server.close()
    for (const sock of socks) sock.destroy()
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(file, resolve)
  })
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  return server
}

export const ROUTES = ['auto', 'mac', 'phone', 'all']

function handle (daemon, sock, req) {
  const reply = (frame) => writeJSON(sock, frame)
  const name = (d) => d.name

  // The menu bar app keeps its connection open (see macos/README.md).
  if (sock.isMac) return daemon.onMacFrame(sock, req)

  if (req.type === 'mac') {
    sock.isMac = true
    daemon.attachMac(sock, req.presence)
  } else if (req.type === 'status') {
    reply({
      type: 'status',
      pid: process.pid,
      mac: daemon.mac ? { presence: daemon.presence() } : null,
      devices: daemon.devices.map((d) => ({ ...d, connected: daemon.isConnected(d.publicKey) }))
    })
    sock.end()
  } else if (req.type === 'reload') {
    daemon.setDevices(config.load().devices)
    reply({ type: 'ok' })
    sock.end()
  } else if (req.type === 'stop') {
    reply({ type: 'ok' })
    sock.end()
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50)
  } else if (req.type === 'pair') {
    const { code, done } = daemon.startPairing(req.timeout || 300_000)
    reply({ type: 'code', code })
    sock.once('close', () => daemon.cancelPairing())
    done.then(
      (device) => { reply({ type: 'paired', device }); sock.end() },
      (err) => { reply({ type: 'error', error: err.message, code: err.code }); sock.end() }
    )
  } else if (req.type === 'listen') {
    const topics = Array.isArray(req.topics)
      ? [...new Set(req.topics.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
      : []
    if (!topics.length) {
      reply({ type: 'error', error: 'Listen to at least one topic' })
      sock.end()
      return
    }
    const stop = daemon.listen(topics, reply)
    sock.once('close', stop)
    reply({ type: 'listening', topics })
  } else if (req.type === 'inbox') {
    const topic = String(req.topic || '').trim().slice(0, 40)
    const messages = topic ? daemon.takeInbox(topic).map(({ type, ...said }) => said) : []
    reply({ type: 'inbox', messages })
    sock.end()
  } else if (req.type === 'send') {
    const targets = config.findDevices({ devices: daemon.devices }, req.device)
    const error = badKey(req.message?.key, req.message?.update === true) || noTarget(daemon, targets, req.device)
    if (error) {
      reply({ type: 'error', error })
      sock.end()
      return
    }

    const message = sanitize(req.message)
    const route = req.device ? 'phone' : ROUTES.includes(req.route) ? req.route : 'auto'
    const entry = daemon.send({ message, targets, route, ttl: message.wantsReply ? (req.timeout || SEND_TTL) : SEND_TTL })
    const where = () => {
      const now = daemon.targetsOf(entry)
      return { targets: now.map(name), connected: now.filter((d) => daemon.isTargetConnected(d.publicKey)).map(name) }
    }

    reply({ type: 'queued', id: entry.id, key: message.key, route: entry.route.to, reason: entry.route.reason, ...where() })

    entry.on('routed', (r) => reply({ type: 'routed', route: r.to, reason: r.reason, ...where() }))
    entry.on('delivered', (d) => reply({ type: 'delivered', device: d.name }))
    entry.on('reply', ({ text, device }) => {
      reply({ type: 'reply', text, device: device.name })
      sock.end()
    })

    // A question nobody waits for any more should not linger on the phone.
    if (message.wantsReply) sock.once('close', () => daemon.close(entry.id))
  } else {
    reply({ type: 'error', error: `Unknown request ${req.type}` })
    sock.end()
  }
}

// Why a send has nowhere to go, or null.
export function noTarget (daemon, targets, device) {
  if (device && !targets.length) return `No paired phone matches "${device}"`
  if (!targets.length && !daemon.mac) return 'No phone paired yet, and the menu bar app is not running. Run: pearbell pair'
  return null
}

export function sanitize (m = {}) {
  const key = cleanKey(m.key)
  const update = key !== '' && m.update === true
  return {
    title: String(m.title || ''),
    body: clipBody(String(m.body || '')),
    topic: String(m.topic || '').trim().slice(0, 40),
    actions: update || !Array.isArray(m.actions) ? [] : m.actions.map(String).slice(0, 3),
    // An update edits a message; it is never a question of its own.
    wantsReply: !update && m.wantsReply === true,
    ...(key ? { key } : {}),
    ...(update ? { update } : {})
  }
}

// Why a message id from a caller can't be used, or null.
export function badKey (key, update) {
  if (key === undefined || key === null || key === '') return update ? 'An update needs the id of the message to change' : null
  return cleanKey(key) ? null : 'A message id is up to 64 characters, without spaces'
}

// CLI side: connect, starting the daemon in the background if needed.
export async function connect ({ start = true } = {}) {
  const file = socketPath()

  try {
    return await dial(file)
  } catch (err) {
    if (!start) throw err
  }

  config.load() // create the identity before the daemon races for it
  if (service.installed()) {
    // launchd or systemd owns the daemon; ask it instead of starting a second one.
    service.kickstart()
  } else {
    const log = fs.openSync(logPath(), 'a')
    spawn(process.execPath, [BIN, 'daemon'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
    fs.closeSync(log)
  }

  const until = Date.now() + 10_000
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      return await dial(file)
    } catch {}
  }
  throw new Error(`Could not start the daemon, see ${logPath()}`)
}

// Send one request and call onframe for each answer until the daemon hangs up.
export function request (sock, req, onframe) {
  return new Promise((resolve) => {
    onJSON(sock, onframe)
    sock.once('close', resolve)
    writeJSON(sock, req)
  })
}

// Hear what the user writes to these topics on the phone, until the daemon
// hangs up or signal aborts. onframe sees the 'listening', 'said' and 'error'
// frames.
export async function listen ({ topics, onframe = noop, signal, start = true }) {
  const sock = await connect({ start })
  const abort = () => sock.end()
  signal?.addEventListener('abort', abort)
  await request(sock, { type: 'listen', topics }, onframe)
  signal?.removeEventListener('abort', abort)
}

// Take what the user wrote to a topic on the phone while nothing listened.
// Resolves the messages, oldest first.
export async function inbox ({ topic, start = true }) {
  const sock = await connect({ start })
  let messages = []
  await request(sock, { type: 'inbox', topic }, (frame) => {
    if (frame.type === 'inbox' && Array.isArray(frame.messages)) messages = frame.messages
  })
  return messages
}

// Send a message through the daemon (starting it if needed) and wait until
// every phone has it, or with message.wantsReply until somebody answers.
// seconds limits the wait (0 = no limit); aborting signal stops waiting, which
// closes an open question. onframe sees each frame from the daemon. start:
// false fails instead of starting the daemon.
// Resolves { queued, delivered, missing, reply, error, timedOut }.
export async function send ({ message, device, route, seconds = 0, signal, onframe = noop, start = true }) {
  const sock = await connect({ start })
  const delivered = new Set()
  let queued = null
  let reply = null
  let error = null
  let timedOut = false

  const timer = seconds > 0
    ? setTimeout(() => { timedOut = true; sock.end() }, seconds * 1000)
    : null
  const abort = () => sock.end()
  signal?.addEventListener('abort', abort)

  await request(sock, { type: 'send', message, device, route, timeout: seconds * 1000 || undefined }, (frame) => {
    if (frame.type === 'queued' || frame.type === 'routed') {
      queued = { ...queued, ...frame }
    } else if (frame.type === 'delivered') {
      delivered.add(frame.device)
    } else if (frame.type === 'reply') {
      reply = frame
    } else if (frame.type === 'error') {
      error = frame
    }
    onframe(frame, delivered)
    if (frame.type === 'delivered' && !message.wantsReply && delivered.size === queued.targets.length) sock.end()
  })
  clearTimeout(timer)
  signal?.removeEventListener('abort', abort)

  const missing = queued ? queued.targets.filter((n) => !delivered.has(n)) : []
  return { queued, delivered: [...delivered], missing, reply, error, timedOut }
}

function dial (file) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(file)
    sock.once('connect', () => {
      sock.off('error', reject)
      sock.on('error', noop)
      resolve(sock)
    })
    sock.once('error', reject)
  })
}

async function reachable (file) {
  try {
    (await dial(file)).destroy()
    return true
  } catch {
    return false
  }
}

function noop () {}
