// The local socket between short-lived CLI commands and the daemon.
// Newline-delimited JSON, one request per connection.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { onJSON, writeJSON } from '../shared/lines.js'
import * as config from './config.js'
import { SEND_TTL } from './daemon.js'

const BIN = fileURLToPath(new URL('./bin.js', import.meta.url))

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

function handle (daemon, sock, req) {
  const reply = (frame) => writeJSON(sock, frame)
  const name = (d) => d.name

  if (req.type === 'status') {
    reply({
      type: 'status',
      pid: process.pid,
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
  } else if (req.type === 'send') {
    const targets = config.findDevices({ devices: daemon.devices }, req.device)
    if (!targets.length) {
      reply({ type: 'error', error: req.device ? `No paired phone matches "${req.device}"` : 'No phone paired yet. Run: pearbell pair' })
      sock.end()
      return
    }

    const message = sanitize(req.message)
    const entry = daemon.send({ message, targets, ttl: message.wantsReply ? (req.timeout || SEND_TTL) : SEND_TTL })

    reply({
      type: 'queued',
      id: entry.id,
      targets: targets.map(name),
      connected: targets.filter((d) => daemon.isConnected(d.publicKey)).map(name)
    })

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

function sanitize (m = {}) {
  return {
    title: String(m.title || ''),
    body: String(m.body || ''),
    actions: Array.isArray(m.actions) ? m.actions.map(String).slice(0, 3) : [],
    wantsReply: m.wantsReply === true
  }
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
  const log = fs.openSync(logPath(), 'a')
  spawn(process.execPath, [BIN, 'daemon'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
  fs.closeSync(log)

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
