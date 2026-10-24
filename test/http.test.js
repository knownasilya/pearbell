import test from 'brittle'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import { Phone } from '../shared/phone.js'
import { Daemon } from '../cli/daemon.js'
import { serveHttp } from '../cli/http.js'

const TOKEN = 'test-token-123'

async function setup (t, onmessage = () => {}) {
  const testnet = await createTestnet(3, t.teardown)
  const node = () => {
    const dht = new DHT({ bootstrap: testnet.bootstrap })
    t.teardown(() => dht.destroy(), { order: Infinity })
    return dht
  }

  const daemon = new Daemon({ dht: node(), keyPair: DHT.keyPair(), name: 'laptop' })
  await daemon.start()
  t.teardown(() => daemon.stop())

  let phone = null
  phone = new Phone({ dht: node(), name: 'pixel', emit: (e) => e.type === 'message' && onmessage(e.message, phone) })
  phone.start()
  t.teardown(() => phone.stop())

  const { code, done } = daemon.startPairing(10_000)
  await phone.pair(code)
  const device = await done
  await waitFor(() => daemon.isConnected(device.publicKey))

  const server = await serveHttp(daemon, { port: 0, token: TOKEN })
  t.teardown(() => { server.close(); server.closeAllConnections() })
  const url = `http://127.0.0.1:${server.address().port}`

  const call = async (path, body, token = TOKEN) => {
    const res = await fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: res.status, json: await res.json() }
  }

  return { daemon, phone, device, call }
}

test('http: wrong token is refused', async (t) => {
  const { call } = await setup(t)
  const res = await call('/send', { body: 'hi' }, 'nope')
  t.is(res.status, 401)
})

test('http: send delivers and lists devices', async (t) => {
  const got = []
  const { call } = await setup(t, (m) => got.push(m))

  const res = await call('/send', { title: 'Daily', topic: ' github-daily ', body: '**3** to do' })
  t.is(res.status, 200)
  t.alike(res.json.delivered, ['pixel'])
  t.is(got[0].title, 'Daily')
  t.is(got[0].body, '**3** to do')
  t.is(got[0].topic, 'github-daily', 'topic trimmed')

  const devices = await call('/devices')
  t.is(devices.json[0].name, 'pixel')
  t.is(devices.json[0].connected, true)
})

test('http: wait returns the reply', async (t) => {
  const { call } = await setup(t, (m, phone) => phone.answer(m.id, 'Ship it'))
  const res = await call('/send', { body: 'Deploy?', actions: 'Ship it,Hold', wait: true, timeout: 10 })
  t.is(res.status, 200)
  t.is(res.json.reply, 'Ship it')
  t.is(res.json.device, 'pixel')
})

test('http: wait times out with 504', async (t) => {
  const { call } = await setup(t)
  const res = await call('/send', { body: 'Anyone?', wait: true, timeout: 1 })
  t.is(res.status, 504)
  t.is(res.json.error, 'timeout')
})

test('http: update changes the message with that id', async (t) => {
  const got = []
  const { call, phone } = await setup(t, (m) => got.push(m))

  const sent = await call('/send', { id: 'deploy', body: '- [ ] build' })
  t.is(sent.status, 200)
  t.is(sent.json.key, 'deploy')

  const updated = await call('/update', { id: 'deploy', body: '- [x] build', title: 'Deploy' })
  t.is(updated.status, 200)
  t.is(got.length, 1, 'no new message')
  t.is(phone.state.messages[0].body, '- [x] build')
  t.is(phone.state.messages[0].title, 'Deploy')
  t.ok(phone.state.messages[0].updatedAt)

  t.is((await call('/update', { body: 'no id' })).status, 400)
  t.is((await call('/update', { id: 'deploy', body: 'x', wait: true })).status, 400)
  t.is((await call('/send', { id: 'two words', body: 'x' })).status, 400)
})

test('http: bad input', async (t) => {
  const { call } = await setup(t)
  t.is((await call('/send', { title: 'no body' })).status, 400)
  t.is((await call('/send', { body: 'x', device: 'nobody' })).status, 400)
  t.is((await call('/nope', {})).status, 404)
})

async function waitFor (fn, timeout = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}
