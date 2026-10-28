#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { parseArgs } from 'node:util'
import DHT from 'hyperdht'
import qrcode from 'qrcode-terminal'
import * as config from './config.js'
import * as control from './control.js'
import { Daemon } from './daemon.js'
import { presenceText } from './router.js'
import { MAX_BODY } from '../shared/protocol.js'
import { serveHttp } from './http.js'
import { defaultTopic, serveMcp } from './mcp.js'
import * as service from './service.js'

const HELP = `pearbell - peer-to-peer messages to your phone

Usage:
  pearbell pair                      Show a code for the phone app to scan
  pearbell send <text...>            Send a notification
  pearbell ask <text...>             Send and wait for a reply (prints it)
  pearbell update <id> <text...>     Change the message sent with --id <id>
                                     (new text; -t and -T change the title
                                     and topic too). No new notification
  pearbell devices                   List paired phones, who is online and the Mac
  pearbell unpair <name|key>         Forget a phone
  pearbell daemon                    Run the background daemon in the
                                     foreground (other commands start it)
  pearbell start                     Start the background daemon if it is
                                     not running (the menu bar app uses it)
  pearbell stop                      Stop the background daemon
  pearbell mcp                       MCP server on stdin/stdout for AI tools
                                     (send, update, ask and devices tools)
  pearbell mcp --channel [-T topic]  ...that is also a Claude Code channel:
                                     what you write to the topic on the
                                     phone reaches the session
  pearbell listen [-T topic]         Print what you write to a topic on the
                                     phone (default topic: this folder name)
  pearbell http [on|off|rotate]      Local web API for tools that can only
                                     make HTTP requests (prints URL, token)
  pearbell service [install|uninstall|status]
                                     Keep the daemon running from login on
                                     (launch agent on macOS, systemd on Linux)

Options for send, ask and update:
  -t, --title <title>                Notification title
  -T, --topic <topic>                Group messages under a topic in the app
  -a, --actions <a,b,c>              Up to 3 quick-reply buttons
  -i, --id <id>                      Your own id for the message, so that
                                     pearbell update <id> can change it
  -d, --device <name|key>            Only this phone (default: all)
      --to <auto|mac|phone|all>      Where to show it. auto (default) uses
                                     the Mac while you are at it and the
                                     phone when you step away (needs the
                                     menu bar app, see macos/)
  -w, --wait                         Wait for a reply (same as ask)
      --timeout <seconds>            How long to wait
                                     (send: 10 for delivery, ask: 600, 0 = never)
      --json                         Print the result as JSON
  -q, --quiet                        No progress output on stderr

Text "-" or no text reads the message from stdin. Messages are Markdown;
"- [ ] task" and "- [x] task" lines show as a checklist, so send one with
--id and tick tasks off with pearbell update. A phone that is offline
gets queued messages when it connects again (for up to a day).
Exit codes: 0 ok, 1 error, 2 timeout.`

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: 'string', short: 't' },
    topic: { type: 'string', short: 'T' },
    actions: { type: 'string', short: 'a' },
    id: { type: 'string', short: 'i' },
    device: { type: 'string', short: 'd' },
    to: { type: 'string' },
    wait: { type: 'boolean', short: 'w' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
    quiet: { type: 'boolean', short: 'q' },
    port: { type: 'string' },
    channel: { type: 'boolean' },
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
    case 'update': return runSend(false, true)
    case 'devices': return runDevices()
    case 'unpair': return runUnpair()
    case 'daemon': return runDaemon()
    case 'start': return runStart()
    case 'stop': return runStop()
    case 'mcp': return runMcp()
    case 'listen': return runListen()
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

async function runSend (wantsReply, update = false) {
  const key = update ? rest.shift() : opts.id
  const bad = control.badKey(key, update)
  if (bad) throw new Error(update ? `${bad}. Use: pearbell update <id> <text...>` : bad)
  if (update && (wantsReply || opts.wait || opts.actions)) throw new Error('An update changes the text of a message; it can\'t ask a question')

  const body = await readBody()
  if (!body) throw new Error('Nothing to send')
  if (body.length > MAX_BODY) log(`message is ${body.length} characters; the phone keeps the first ${MAX_BODY}`)

  const seconds = opts.timeout === undefined ? (wantsReply ? 600 : 10) : Number(opts.timeout)
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--timeout takes a number of seconds')

  if (opts.to && !control.ROUTES.includes(opts.to)) throw new Error(`--to takes one of ${control.ROUTES.join(', ')}`)

  const actions = opts.actions ? opts.actions.split(',').map((a) => a.trim()).filter(Boolean) : []
  const message = { title: opts.title || '', topic: opts.topic || '', body, actions, wantsReply, key, update }

  const onframe = (frame, delivered) => {
    if (frame.type === 'queued' || frame.type === 'routed') {
      if (frame.type === 'queued' && key && frame.key !== key) log('the running daemon is older and ignores message ids; restart it with: pearbell stop')
      if (frame.type === 'routed' || frame.reason !== 'the menu bar app is not running') {
        log(frame.type === 'routed' ? `also sent to the phone: ${frame.reason}` : `routed to ${where(frame.route)}: ${frame.reason}`)
      }
      const offline = frame.targets.filter((n) => !frame.connected.includes(n) && !delivered.has(n))
      if (offline.length) log(`waiting for ${offline.join(', ')} to connect`)
    } else if (frame.type === 'delivered') {
      log(`delivered to ${frame.device}`)
    }
  }

  const { queued, delivered, missing, reply, error, timedOut } = await control.send({ message, device: opts.device, route: opts.to, seconds, onframe })

  if (error) throw daemonError(error)

  if (wantsReply) {
    if (!reply) {
      throw new TimeoutError(timedOut ? `No reply within ${seconds}s` : 'The daemon stopped')
    }
    if (opts.json) console.log(JSON.stringify({ id: queued.id, ...(key ? { key } : {}), reply: reply.text, device: reply.device }))
    else console.log(reply.text)
    return 0
  }

  if (missing.length) log(`${missing.join(', ')} offline; the message waits in the queue`)
  if (opts.json) console.log(JSON.stringify({ id: queued.id, ...(key ? { key } : {}), route: queued.route, delivered, queued: missing }))
  return 0
}

async function runDevices () {
  let devices = config.load().devices.map((d) => ({ ...d, connected: null }))
  let mac = null

  try {
    const sock = await control.connect({ start: false })
    await control.request(sock, { type: 'status' }, (frame) => {
      devices = frame.devices
      mac = frame.mac
    })
  } catch {}

  // --json stays the list of phones; the menu bar app is only in the text.
  if (opts.json) {
    console.log(JSON.stringify(devices))
    return 0
  }
  if (!devices.length) {
    console.log('No phone paired yet. Run: pearbell pair')
  }
  for (const d of devices) {
    const state = d.connected === null ? 'daemon not running' : d.connected ? 'online' : 'offline'
    console.log(`${d.name}  ${d.publicKey.slice(0, 12)}  ${state}  paired ${new Date(d.pairedAt).toLocaleString()}`)
  }
  if (mac) console.log(`this Mac (menu bar app)  ${presenceText(mac.presence)}`)
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

async function runStart () {
  ;(await control.connect()).end()
  console.log('Daemon running')
  return 0
}

async function runStop () {
  if (service.installed()) {
    service.kickstart({ restart: true })
    console.log(`The ${service.kind()} keeps the daemon running, so it was restarted.`)
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

async function runMcp () {
  const channel = opts.channel ? topicOption() : null
  await serveMcp({ channel })
  return 0
}

async function runListen () {
  const topic = topicOption()
  let error = null
  await control.listen({
    topics: [topic],
    onframe (frame) {
      if (frame.type === 'listening') log(`listening on ${topic}`)
      else if (frame.type === 'error') error = frame
      else if (frame.type === 'said') console.log(opts.json ? JSON.stringify({ id: frame.id, topic: frame.topic, text: frame.text, device: frame.device }) : `${frame.device}: ${frame.text}`)
    }
  })
  if (error) throw daemonError(error)
  throw new Error('The daemon stopped')
}

function topicOption () {
  const topic = (opts.topic ?? defaultTopic()).trim().slice(0, 40)
  if (!topic) throw new Error('Give a topic with -T')
  return topic
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
    // Hand the daemon over to launchd or systemd: stop the one the CLI started, if any.
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
    console.log(`Installed ${service.file()}`)
    console.log('The daemon now starts at login and restarts if it stops.')
    if (process.platform === 'linux') console.log(`To keep it running while you're logged out: loginctl enable-linger ${os.userInfo().username}`)
  } else if (action === 'uninstall') {
    service.uninstall()
    console.log(`Removed the ${service.kind()} and stopped the daemon. Any pearbell command starts it again.`)
    return 0
  } else if (action !== 'status') {
    throw new Error('Use: pearbell service [install|uninstall|status]')
  }

  const s = service.status()
  const name = service.kind()[0].toUpperCase() + service.kind().slice(1)
  if (!s.installed) console.log(service.supported() ? `${name} not installed. Install it with: pearbell service install` : 'pearbell service only supports macOS and Linux')
  else console.log(`${name} installed, daemon ${s.running ? `running (pid ${s.pid})` : 'not running'}`)
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


function where (route) {
  return { mac: 'the Mac', phone: 'the phone', both: 'the Mac and the phone' }[route] || route
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
