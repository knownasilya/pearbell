// Optional HTTP API on the daemon, for tools that can only make web requests
// (a Kody job, a CI webhook relay, Shortcuts). Listens on 127.0.0.1 only, and
// every request needs the token from `pearbell http on`.
//
//   POST /send  { body, title?, topic?, actions?, device?, to?, wait?, timeout? }
//     -> 200 { id, route, delivered, queued } without wait
//     -> 200 { id, reply, device }           with wait
//     -> 504 { error: 'timeout' }            no reply (or no delivery) in time
//   GET /devices -> [{ name, publicKey, connected }]
import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import * as config from './config.js'
import { ROUTES, noTarget, sanitize } from './control.js'
import { SEND_TTL } from './daemon.js'

const MAX_BODY = 64 * 1024

export async function serveHttp (daemon, { port, token }) {
  const server = http.createServer((req, res) => {
    handle(daemon, token, req, res).catch((err) => reply(res, 500, { error: err.message }))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

async function handle (daemon, token, req, res) {
  if (!authorized(req.headers.authorization, token)) return reply(res, 401, { error: 'unauthorized' })

  const url = new URL(req.url, 'http://127.0.0.1')

  if (req.method === 'GET' && url.pathname === '/devices') {
    return reply(res, 200, daemon.devices.map((d) => ({ name: d.name, publicKey: d.publicKey, connected: daemon.isConnected(d.publicKey) })))
  }

  if (req.method !== 'POST' || url.pathname !== '/send') return reply(res, 404, { error: 'not found' })

  let input
  try {
    input = JSON.parse(await readBody(req))
  } catch (err) {
    return reply(res, 400, { error: err.message === 'too large' ? 'body too large' : 'body must be JSON' })
  }

  const actions = typeof input.actions === 'string' ? input.actions.split(',').map((a) => a.trim()).filter(Boolean) : input.actions
  const message = sanitize({ ...input, actions, wantsReply: input.wait === true })
  if (!message.body.trim()) return reply(res, 400, { error: 'body is required' })

  if (input.to !== undefined && !ROUTES.includes(input.to)) return reply(res, 400, { error: `to must be one of ${ROUTES.join(', ')}` })

  const targets = config.findDevices({ devices: daemon.devices }, input.device)
  const error = noTarget(daemon, targets, input.device)
  if (error) return reply(res, 400, { error })

  const route = input.device ? 'phone' : input.to || 'auto'
  const seconds = Number.isFinite(input.timeout) && input.timeout >= 0 ? input.timeout : (message.wantsReply ? 600 : 10)
  const entry = daemon.send({ message, targets, route, ttl: message.wantsReply && seconds > 0 ? seconds * 1000 : SEND_TTL })
  const delivered = new Set()
  const names = () => daemon.targetsOf(entry).filter((d) => delivered.has(d.publicKey)).map((d) => d.name)
  const missing = () => daemon.targetsOf(entry).filter((d) => !delivered.has(d.publicKey)).map((d) => d.name)

  await new Promise((resolve) => {
    let done = false
    const finish = (status, body) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reply(res, status, body)
      resolve()
    }

    const timer = seconds > 0
      ? setTimeout(() => {
        if (message.wantsReply) {
          daemon.close(entry.id)
          finish(504, { id: entry.id, error: 'timeout', delivered: names() })
        } else {
          // Not delivered yet: it stays queued, as with `pearbell send`.
          finish(200, { id: entry.id, route: entry.route.to, delivered: names(), queued: missing() })
        }
      }, seconds * 1000)
      : null

    entry.on('delivered', (d) => {
      delivered.add(d.publicKey)
      if (!message.wantsReply && delivered.size === entry.targets.size) finish(200, { id: entry.id, route: entry.route.to, delivered: names(), queued: [] })
    })
    entry.on('reply', ({ text, device }) => finish(200, { id: entry.id, reply: text, device: device.name }))

    // A caller that gives up on a question should not leave it open on the phone.
    res.once('close', () => {
      if (!done && message.wantsReply) daemon.close(entry.id)
      if (!done) { done = true; clearTimeout(timer); resolve() }
    })
  })
}

function authorized (header, token) {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function reply (res, status, body) {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
