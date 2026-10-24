#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import DHT from 'hyperdht'
import qrcode from 'qrcode-terminal'
import * as config from './config.js'
import * as control from './control.js'
import { Daemon } from './daemon.js'
import { serveHttp } from './http.js'
import * as service from './service.js'

const HELP = `pearbell - peer-to-peer messages to your phone

Usage:
  pearbell pair                      Show a code for the phone app to scan
  pearbell send <text...>            Send a notification
  pearbell ask <text...>             Send and wait for a reply (prints it)
  pearbell devices                   List paired phones and who is online
  pearbell unpair <name|key>         Forget a phone
  pearbell daemon                    Run the background daemon in the
                                     foreground (other commands start it)
  pearbell stop                      Stop the background daemon
  pearbell http [on|off|rotate]      Local web API for tools that can only
                                     make HTTP requests (prints URL, token)
  pearbell service [install|uninstall|status]
                                     Keep the daemon running from login on
                                     (macOS launch agent)

Options for send and ask:
  -t, --title <title>                Notification title
  -a, --actions <a,b,c>              Up to 3 quick-reply buttons
  -d, --device <name|key>            Only this phone (default: all)
  -w, --wait                         Wait for a reply (same as ask)
      --timeout <seconds>            How long to wait
                                     (send: 10 for delivery, ask: 600, 0 = never)
      --json                         Print the result as JSON
  -q, --quiet                        No progress output on stderr

Text "-" or no text reads the message from stdin. A phone that is offline
gets queued messages when it connects again (for up to a day).
Exit codes: 0 ok, 1 error, 2 timeout.`

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string', short: 't' },
    actions: { type: 'string', short: 'a' },
    device: { type: 'string', short: 'd' },
    wait: { type: 'boolean', short: 'w' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' }
  }
})

const [command, ...rest] = positionals
const log = opts.quiet ? () => {} : (line) => process.stderr.write(line + '\n')

class TimeoutError extends Error {
  code = 'TIMEOUT'
}

try {
  process.exitCode = await run()
} catch (err) {
  process.stderr.write(`pearbell: ${err.message}\n`)
  process.exitCode = err.code === 'TIMEOUT' ? 2 : 1
}

async function run () {
  if (opts.help || !command || command === 'help') {
    console.log(HELP)
    return 0
  }

  switch (command) {
    case 'pair': return runPair()
    case 'send': return runSend(opts.wait === true)
    case 'ask': return runSend(true)
    case 'devices': return runDevices()
    case 'unpair': return runUnpair()
    case 'daemon': return runDaemon()
    case 'stop': return runStop()
    case 'http': return runHttp()
    case 'service': return runService()
    default: throw new Error(`Unknown command "${command}". Try pearbell --help`)
  }
}

async function runPair () {
  const sock = await control.connect()
  let result = null

  await control.request(sock, { type: 'pair', timeout: 300_000 }, (frame) => {
    if (frame.type === 'code') {
      qrcode.generate(frame.code, { small: true }, (qr) => console.log(qr))
      console.log('Scan this in the pearbell app, or paste the code:\n')
      console.log('  ' + frame.code + '\n')
      console.log('Waiting for the phone...')
    } else {
      result = frame
    }
  })

  if (result?.type !== 'paired') throw daemonError(result)
  console.log(`Paired with ${result.device.name}`)
  return 0
}

async function runSend (wantsReply) {
  const body = await readBody()
  if (!body) throw new Error('Nothing to send')

  const seconds = opts.timeout === undefined ? (wantsReply ? 600 : 10) : Number(opts.timeout)
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--timeout takes a number of seconds')

  const actions = opts.actions ? opts.actions.split(',').map((a) => a.trim()).filter(Boolean) : []
  const message = { title: opts.title || '', body, actions, wantsReply }

  const sock = await control.connect()
  const delivered = new Set()
  let queued = null
  let reply = null
  let error = null
  let timedOut = false

  const timer = seconds > 0
    ? setTimeout(() => { timedOut = true; sock.end() }, seconds * 1000)
    : null

  await control.request(sock, { type: 'send', message, device: opts.device, timeout: seconds * 1000 || undefined }, (frame) => {
    if (frame.type === 'queued') {
      queued = frame
      const offline = frame.targets.filter((n) => !frame.connected.includes(n))
      if (offline.length) log(`waiting for ${offline.join(', ')} to connect`)
    } else if (frame.type === 'delivered') {
      delivered.add(frame.device)
      log(`delivered to ${frame.device}`)
      if (!wantsReply && delivered.size === queued.targets.length) sock.end()
    } else if (frame.type === 'reply') {
      reply = frame
    } else if (frame.type === 'error') {
      error = frame
    }
  })
  clearTimeout(timer)

  if (error) throw daemonError(error)

  if (wantsReply) {
    if (!reply) {
      throw new TimeoutError(timedOut ? `No reply within ${seconds}s` : 'The daemon stopped')
    }
    if (opts.json) console.log(JSON.stringify({ id: queued.id, reply: reply.text, device: reply.device }))
    else console.log(reply.text)
    return 0
  }

  const missing = queued.targets.filter((n) => !delivered.has(n))
  if (missing.length) log(`${missing.join(', ')} offline; the message waits in the queue`)
  if (opts.json) console.log(JSON.stringify({ id: queued.id, delivered: [...delivered], queued: missing }))
  return 0
}

async function runDevices () {
  let devices = config.load().devices.map((d) => ({ ...d, connected: null }))

  try {
    const sock = await control.connect({ start: false })
    await control.request(sock, { type: 'status' }, (frame) => { devices = frame.devices })
  } catch {}

  if (opts.json) {
    console.log(JSON.stringify(devices))
  } else if (!devices.length) {
    console.log('No phone paired yet. Run: pearbell pair')
  } else {
    for (const d of devices) {
      const state = d.connected === null ? 'daemon not running' : d.connected ? 'online' : 'offline'
      console.log(`${d.name}  ${d.publicKey.slice(0, 12)}  ${state}  paired ${new Date(d.pairedAt).toLocaleString()}`)
    }
  }
  return 0
}

async function runUnpair () {
  const cfg = config.load()
  const matches = config.findDevices(cfg, rest[0])
  if (!rest[0] || !matches.length) throw new Error('Name a paired phone, see: pearbell devices')

  cfg.devices = cfg.devices.filter((d) => !matches.includes(d))
  config.save(cfg)

  try {
    const sock = await control.connect({ start: false })
    await control.request(sock, { type: 'reload' }, () => {})
  } catch {}

  for (const d of matches) console.log(`Forgot ${d.name}`)
  return 0
}

async function runStop () {
  if (service.installed()) {
    service.kickstart({ restart: true })
    console.log('The launch agent keeps the daemon running, so it was restarted.')
    console.log('To stop it for good: pearbell service uninstall')
    return 0
  }
  try {
    const sock = await control.connect({ start: false })
    await control.request(sock, { type: 'stop' }, () => {})
    console.log('Daemon stopped')
  } catch {
    console.log('Daemon is not running')
  }
  return 0
}

async function runHttp () {
  const action = rest[0] || 'show'
  const cfg = config.load()

  if (action === 'on' || action === 'rotate') {
    const port = opts.port ? Number(opts.port) : cfg.http?.port || 7457
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port takes a port number')
    const token = action === 'rotate' || !cfg.http?.token ? randomBytes(24).toString('base64url') : cfg.http.token
    cfg.http = { port, token }
    config.save(cfg)
    await restartDaemon()
  } else if (action === 'off') {
    delete cfg.http
    config.save(cfg)
    await restartDaemon()
    console.log('HTTP API is off')
    return 0
  } else if (action !== 'show') {
    throw new Error('Use: pearbell http [on|off|rotate] [--port 7457]')
  }

  if (!cfg.http) {
    console.log('HTTP API is off. Turn it on with: pearbell http on')
    return 0
  }

  const url = `http://127.0.0.1:${cfg.http.port}`
  if (opts.json) {
    console.log(JSON.stringify({ url, token: cfg.http.token }))
  } else {
    console.log(`HTTP API: ${url} (this computer only)`)
    console.log(`Token:    ${cfg.http.token}\n`)
    console.log(`curl -s ${url}/send -H "authorization: Bearer $TOKEN" -d '{"title":"Hi","body":"From curl"}'`)
  }
  return 0
}

// Stop the daemon (if any) and start a fresh one that reads the new config.
async function restartDaemon () {
  if (service.installed()) {
    service.kickstart({ restart: true })
    await waitForDaemon()
    return
  }
  try {
    const sock = await control.connect({ start: false })
    let pid = null
    await control.request(sock, { type: 'status' }, (frame) => { pid = frame.pid })
    const stop = await control.connect({ start: false })
    await control.request(stop, { type: 'stop' }, () => {})
    for (let i = 0; pid && i < 100; i++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } catch {}
  ;(await control.connect()).end()
}

async function runService () {
  const action = rest[0] || 'status'

  if (action === 'install') {
    // Hand the daemon over to launchd: stop the one the CLI started, if any.
    try {
      const sock = await control.connect({ start: false })
      let pid = null
      await control.request(sock, { type: 'status' }, (frame) => { pid = frame.pid })
      const stop = await control.connect({ start: false })
      await control.request(stop, { type: 'stop' }, () => {})
      for (let i = 0; pid && i < 100; i++) {
        try { process.kill(pid, 0) } catch { break }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } catch {}
    service.install(control.BIN)
    await waitForDaemon()
    console.log(`Installed ${service.plistPath()}`)
    console.log('The daemon now starts at login and restarts if it stops.')
  } else if (action === 'uninstall') {
    service.uninstall()
    console.log('Removed the launch agent and stopped the daemon. Any pearbell command starts it again.')
    return 0
  } else if (action !== 'status') {
    throw new Error('Use: pearbell service [install|uninstall|status]')
  }

  const s = service.status()
  if (!s.installed) console.log(service.supported() ? 'Launch agent not installed. Install it with: pearbell service install' : 'pearbell service only supports macOS for now')
  else console.log(`Launch agent installed, daemon ${s.running ? `running (pid ${s.pid})` : 'not running'}`)
  return 0
}

async function waitForDaemon () {
  for (let i = 0; i < 100; i++) {
    try {
      (await control.connect({ start: false })).end()
      return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`The daemon did not start, see ${control.logPath()}`)
}

async function runDaemon () {
  const cfg = config.load()
  const dht = new DHT()
  const daemon = new Daemon({ dht, keyPair: config.keyPair(cfg), devices: cfg.devices, name: config.computerName() })
  const stamp = () => new Date().toISOString()

  daemon.on('devices', (devices) => config.save({ ...config.load(), devices }))
  daemon.on('connect', (d) => console.log(`${stamp()} ${d.name} connected`))
  daemon.on('disconnect', (d) => d && console.log(`${stamp()} ${d.name} disconnected`))

  await daemon.start()
  const server = await control.serve(daemon)
  console.log(`${stamp()} pearbell daemon ${process.pid} listening, ${cfg.devices.length} paired phone(s)`)

  let web = null
  if (cfg.http?.token) {
    web = await serveHttp(daemon, cfg.http)
    console.log(`${stamp()} HTTP API on http://127.0.0.1:${cfg.http.port}`)
  }

  await new Promise((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })

  console.log(`${stamp()} stopping`)
  if (web) { web.close(); web.closeAllConnections() }
  server.closeAll()
  if (process.platform !== 'win32') fs.rmSync(control.socketPath(), { force: true })
  await daemon.stop()
  await dht.destroy()
  return 0
}


function daemonError (frame) {
  const err = new Error(frame?.error || 'The daemon closed the connection')
  if (frame?.code) err.code = frame.code
  return err
}

async function readBody () {
  const text = rest.join(' ')
  if (text && text !== '-') return text
  if (process.stdin.isTTY) return ''

  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}
