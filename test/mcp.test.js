import test from 'brittle'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { onJSON, writeJSON } from '../shared/lines.js'

const BIN = new URL('../cli/bin.js', import.meta.url).pathname

// `pearbell mcp` in a child process, talking to a stand-in daemon on the
// control socket. ondaemon(req, reply, sock) answers each daemon request.
async function setup (t, ondaemon) {
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

  const child = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, PEARBELL_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] })
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
