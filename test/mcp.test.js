import test from 'brittle'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { onJSON, writeJSON } from '../shared/lines.js'
import { serveHttp } from '../cli/http.js'
import { defaultTopic } from '../cli/mcp.js'

const BIN = new URL('../cli/bin.js', import.meta.url).pathname

// A stand-in daemon on the control socket in a fresh PEARBELL_HOME.
// ondaemon(req, reply, sock) answers each daemon request.
async function fakeDaemon (t, ondaemon) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pearbell-mcp-'))
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }))

  const requests = []
  const server = net.createServer((sock) => {
    sock.on('error', () => {})
    onJSON(sock, (req) => {
      requests.push(req)
      ondaemon(req, (frame) => writeJSON(sock, frame), sock)
    })
  })
  await new Promise((resolve) => server.listen(path.join(home, 'daemon.sock'), resolve))
  t.teardown(() => server.close())
  return { home, requests }
}

// `pearbell mcp` in a child process, talking to a stand-in daemon.
async function setup (t, ondaemon, args = []) {
  const { home, requests } = await fakeDaemon(t, ondaemon)

  const child = spawn(process.execPath, [BIN, 'mcp', ...args], { env: { ...process.env, PEARBELL_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] })
  t.teardown(() => child.kill())

  const pending = new Map()
  const notes = []
  onJSON(child.stdout, (frame) => {
    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)(frame)
      pending.delete(frame.id)
    } else {
      notes.push(frame)
    }
  })

  let next = 1
  const rpc = (method, params) => {
    const id = next++
    writeJSON(child.stdin, { jsonrpc: '2.0', id, method, params })
    return { id, done: new Promise((resolve) => pending.set(id, resolve)) }
  }
  const call = async (method, params) => (await rpc(method, params).done)
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result

  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  writeJSON(child.stdin, { jsonrpc: '2.0', method: 'notifications/initialized' })

  return { init, call, rpc, tool, requests, notes, child }
}

const deliver = (req, reply, sock) => {
  if (req.type !== 'send') return
  reply({ type: 'queued', id: 'm1', key: req.message.key, route: 'phone', targets: ['pixel'], connected: ['pixel'] })
  reply({ type: 'delivered', device: 'pixel' })
}

test('mcp: initialize and list tools', async (t) => {
  const { init, call } = await setup(t, deliver)
  t.is(init.result.protocolVersion, '2025-06-18')
  t.is(init.result.serverInfo.name, 'pearbell')
  t.ok(init.result.capabilities.tools)

  const { result } = await call('tools/list')
  t.alike(result.tools.map((x) => x.name), ['send', 'update', 'ask', 'devices'])
  t.alike(result.tools.find((x) => x.name === 'update').inputSchema.required, ['id', 'body'])

  const unknown = await call('nope')
  t.is(unknown.error.code, -32601)
})

test('mcp: send passes the message to the daemon', async (t) => {
  const { tool, requests } = await setup(t, deliver)
  const res = await tool('send', { body: '**done**\n- [x] tests', title: 'Claude Code', topic: 'ci', id: 'run-1' })

  t.absent(res.isError)
  t.alike(res.structuredContent, { id: 'm1', key: 'run-1', route: 'phone', delivered: ['pixel'], queued: [] })
  t.alike(JSON.parse(res.content[0].text), res.structuredContent)

  const { message } = requests[0]
  t.is(message.body, '**done**\n- [x] tests', 'Markdown arrives as is')
  t.is(message.title, 'Claude Code')
  t.is(message.topic, 'ci')
  t.is(message.key, 'run-1')
  t.is(message.wantsReply, false)
})

test('mcp: update needs an id and marks the message as an update', async (t) => {
  const { tool, requests } = await setup(t, deliver)

  const missing = await tool('update', { body: 'x' })
  t.ok(missing.isError)
  t.ok(/id/.test(missing.content[0].text))
  t.is(requests.length, 0, 'nothing sent')

  const res = await tool('update', { id: 'run-1', body: '- [x] build\n- [ ] ship' })
  t.absent(res.isError)
  t.is(requests[0].message.update, true)
  t.is(requests[0].message.key, 'run-1')
})

test('mcp: ask waits for the reply', async (t) => {
  const { tool, requests } = await setup(t, (req, reply, sock) => {
    deliver(req, reply)
    setTimeout(() => { reply({ type: 'reply', text: 'Ship it', device: 'pixel' }); sock.end() }, 50)
  })

  const res = await tool('ask', { body: 'Deploy?', actions: ['Ship it', 'Hold'], timeout: 5 })
  t.absent(res.isError)
  t.is(res.structuredContent.reply, 'Ship it')
  t.is(res.structuredContent.device, 'pixel')
  t.is(requests[0].message.wantsReply, true)
  t.alike(requests[0].message.actions, ['Ship it', 'Hold'])
  t.is(requests[0].timeout, 5000)
})

test('mcp: ask times out as a tool error', async (t) => {
  const { tool } = await setup(t, deliver)
  const res = await tool('ask', { body: 'Anyone?', timeout: 0.2 })
  t.ok(res.isError)
  t.ok(/No reply within/.test(res.content[0].text))
})

test('mcp: cancelling an ask hangs up on the daemon', async (t) => {
  let closed = null
  const hungUp = new Promise((resolve) => { closed = resolve })
  const { rpc, child } = await setup(t, (req, reply, sock) => {
    deliver(req, reply)
    sock.once('end', closed)
  })

  const { id, done } = rpc('tools/call', { name: 'ask', arguments: { body: 'Wait?' } })
  await new Promise((resolve) => setTimeout(resolve, 100))
  writeJSON(child.stdin, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })

  await hungUp
  const res = (await done).result
  t.ok(res.isError)
  t.is(res.content[0].text, 'Cancelled')
})

test('mcp: daemon errors come back as tool errors', async (t) => {
  const { tool } = await setup(t, (req, reply, sock) => {
    reply({ type: 'error', error: 'No paired phone matches "nobody"' })
    sock.end()
  })
  const res = await tool('send', { body: 'hi', device: 'nobody' })
  t.ok(res.isError)
  t.is(res.content[0].text, 'No paired phone matches "nobody"')
})

test('mcp: devices lists phones and the Mac', async (t) => {
  const { tool } = await setup(t, (req, reply, sock) => {
    reply({ type: 'status', pid: 1, mac: null, devices: [{ name: 'pixel', publicKey: 'ab', connected: true }] })
    sock.end()
  })
  const res = await tool('devices', {})
  t.alike(res.structuredContent, { phones: [{ name: 'pixel', connected: true }], mac: null })
})

test('mcp: exits when the client hangs up', async (t) => {
  const { child } = await setup(t, deliver)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.stdin.end()
  t.is(await exited, 0)
})

test('mcp: without --channel it is no channel', async (t) => {
  const { init, requests } = await setup(t, deliver)
  t.absent(init.result.capabilities.experimental)
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(requests.length, 0, 'no listen')
})

test('mcp: --channel passes what the user writes to the topic on to the session', async (t) => {
  const { init, notes, requests } = await setup(t, (req, reply) => {
    if (req.type !== 'listen') return
    reply({ type: 'listening', topics: req.topics })
    reply({ type: 'said', id: 's1', topic: 'demo', text: 'How is it going?', device: 'Pixel 8' })
  }, ['--channel', '-T', 'demo'])

  t.alike(init.result.capabilities.experimental, { 'claude/channel': {} })
  t.ok(init.result.instructions.includes('topic "demo"'))

  const note = await waitFor(() => notes.find((n) => n.method === 'notifications/claude/channel'))
  t.alike(requests[0], { type: 'listen', topics: ['demo'] })
  t.alike(note.params, { content: 'How is it going?', meta: { topic: 'demo', device: 'Pixel 8' } })
})

test('mcp: --channel listens again when the daemon hangs up', async (t) => {
  let listens = 0
  const { requests } = await setup(t, (req, reply, sock) => {
    if (req.type !== 'listen') return
    listens++
    reply({ type: 'listening', topics: req.topics })
    if (listens === 1) sock.end()
  }, ['--channel', '-T', 'demo'])

  await waitFor(() => listens === 2, 5000)
  t.is(requests.filter((r) => r.type === 'listen').length, 2)
})

test('mcp: the channel topic is the project folder', (t) => {
  t.is(defaultTopic({ CLAUDE_PROJECT_DIR: '/home/me/code/pearbell' }, '/tmp'), 'pearbell')
  t.is(defaultTopic({}, '/home/me/kody'), 'kody')
  t.is(defaultTopic({ PEARBELL_TOPIC: 'work', CLAUDE_PROJECT_DIR: '/x/y' }, '/tmp'), 'work')
  t.is(defaultTopic({}, '/x/' + 'a'.repeat(50)).length, 40)
})

async function waitFor (fn, timeout = 3000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}

// POST /mcp on the HTTP API, in this process, with the stand-in daemon.
async function setupHttp (t, ondaemon) {
  const { home, requests } = await fakeDaemon(t, ondaemon)
  const before = process.env.PEARBELL_HOME
  process.env.PEARBELL_HOME = home
  t.teardown(() => { if (before === undefined) delete process.env.PEARBELL_HOME; else process.env.PEARBELL_HOME = before })

  const server = await serveHttp({ devices: [] }, { port: 0, token: 'tok' })
  t.teardown(() => { server.close(); server.closeAllConnections() })
  const url = `http://127.0.0.1:${server.address().port}/mcp`

  const post = async (body, token = 'tok') => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    return { status: res.status, type: res.headers.get('content-type'), json: text ? JSON.parse(text) : null }
  }
  return { post, url, requests }
}

test('mcp over http: initialize, list and call tools', async (t) => {
  const { post, requests } = await setupHttp(t, deliver)

  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'kody', version: '1' } } })
  t.is(init.status, 200)
  t.is(init.type, 'application/json')
  t.is(init.json.result.protocolVersion, '2025-03-26')

  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  t.is(note.status, 202)

  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  t.is(list.json.result.tools.length, 4)

  const sent = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send', arguments: { body: 'hi', id: 'k1' } } })
  t.is(sent.json.id, 3)
  t.alike(sent.json.result.structuredContent.delivered, ['pixel'])
  t.is(requests[0].message.key, 'k1')
})

test('mcp over http: token, method and bad JSON', async (t) => {
  const { post, url } = await setupHttp(t, deliver)
  t.is((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'nope')).status, 401)
  t.is((await fetch(url, { headers: { authorization: 'Bearer tok' } })).status, 405)

  const bad = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer tok' }, body: '{nope' })
  t.is(bad.status, 400)
  t.is((await bad.json()).error.code, -32700)
})

test('mcp over http: a client that hangs up closes the question', async (t) => {
  let closed = null
  const hungUp = new Promise((resolve) => { closed = resolve })
  const { url } = await setupHttp(t, (req, reply, sock) => {
    deliver(req, reply)
    sock.once('end', closed)
  })

  const stop = new AbortController()
  const asking = fetch(url, {
    method: 'POST',
    signal: stop.signal,
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask', arguments: { body: 'Wait?' } } })
  }).catch(() => null)

  await new Promise((resolve) => setTimeout(resolve, 200))
  stop.abort()
  await asking
  await hungUp
  t.pass('the daemon saw the question go')
})
