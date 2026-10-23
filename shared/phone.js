// The phone side of pearbell. It runs inside the Android app's Bare worklet,
// and in Node for tests and for test/fake-phone.js.
//
// For each paired computer the phone keeps one outgoing connection open and
// redials when it drops. The host (Android or a test) gives it a plain JSON
// state object and a save() function, and gets events through emit().
import DHT from 'hyperdht'
import crypto from 'hypercore-crypto'
import { onJSON, writeJSON } from './lines.js'
import { decodePairCode, opened, toHex, fromHex } from './protocol.js'

const MAX_MESSAGES = 200
const PAIR_TIMEOUT = 30_000
const MIN_RETRY = 1_000
const MAX_RETRY = 30_000

export class Phone {
  constructor ({ dht, state = {}, save = noop, emit = noop }) {
    this.dht = dht
    this.state = {
      seed: state.seed || toHex(crypto.randomBytes(32)),
      peers: state.peers || [],
      messages: state.messages || []
    }
    this.save = () => save(this.state)
    this.emit = emit
    this.keyPair = DHT.keyPair(fromHex(this.state.seed))
    this.links = new Map()
    this.started = false

    // A new network (Wi-Fi to mobile data, say) is worth an instant redial.
    this._onnetworkchange = () => {
      for (const link of this.links.values()) link.kick()
    }

    if (!state.seed) this.save()
  }

  get publicKey () {
    return this.keyPair.publicKey
  }

  start () {
    this.started = true
    this.dht.on('network-change', this._onnetworkchange)
    for (const peer of this.state.peers) this._link(peer)
    this.emit({ type: 'ready', publicKey: toHex(this.publicKey), ...this.snapshot() })
  }

  async stop () {
    this.started = false
    this.dht.off('network-change', this._onnetworkchange)
    for (const link of this.links.values()) link.close()
    this.links.clear()
  }

  snapshot () {
    const peers = this.state.peers.map((p) => ({ ...p, connected: this.links.get(p.publicKey)?.connected || false }))
    return { peers, messages: this.state.messages }
  }

  findPeer (publicKey) {
    return this.state.peers.find((p) => p.publicKey === publicKey) || null
  }

  findMessage (id) {
    return this.state.messages.find((m) => m.id === id) || null
  }

  // Dial the computer named in the pairing code and prove we hold its token.
  async pair (code, name) {
    const { publicKey, token } = decodePairCode(code)
    const conn = this.dht.connect(publicKey, { keyPair: this.keyPair })
    conn.on('error', noop)

    try {
      await opened(conn)

      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Pairing timed out')), PAIR_TIMEOUT)
        onJSON(conn, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        conn.once('close', () => {
          clearTimeout(timer)
          reject(new Error('The computer closed the connection'))
        })
        writeJSON(conn, { type: 'pair', token: toHex(token), name })
      })

      if (answer.type !== 'paired') throw new Error(answer.error || 'Pairing refused')

      const peer = {
        publicKey: toHex(publicKey),
        name: String(answer.name || 'computer').slice(0, 64),
        pairedAt: Date.now()
      }

      this.links.get(peer.publicKey)?.close()
      this.state.peers = this.state.peers.filter((p) => p.publicKey !== peer.publicKey)
      this.state.peers.push(peer)
      this.save()
      if (this.started) this._link(peer)

      this.emit({ type: 'paired', peer })
      this._emitState()
      return peer
    } finally {
      conn.end()
    }
  }

  unpair (publicKey) {
    this.links.get(publicKey)?.close()
    this.links.delete(publicKey)
    this.state.peers = this.state.peers.filter((p) => p.publicKey !== publicKey)
    this.save()
    this._emitState()
  }

  clear () {
    this.state.messages = []
    this.save()
    this._emitState()
  }

  // The user answered a message, from a notification or from the app.
  answer (id, text) {
    const msg = this.findMessage(id)
    if (!msg || msg.answer !== null || msg.closed) return false

    msg.answer = String(text)
    msg.answeredAt = Date.now()
    this.save()
    this.emit({ type: 'updated', message: msg })

    // If the link is down, the reply goes out when it comes back (see _onopen).
    this.links.get(msg.from)?.send({ type: 'reply', id, text: msg.answer })
    return true
  }

  _link (peer) {
    const link = new Link(this, peer)
    this.links.set(peer.publicKey, link)
    link.run()
  }

  _emitState () {
    this.emit({ type: 'state', ...this.snapshot() })
  }

  _onopen (link) {
    this._emitState()

    const pending = []
    for (const msg of this.state.messages) {
      if (msg.from !== link.peer.publicKey || !msg.wantsReply || msg.closed) continue
      // Replies given while we were offline.
      if (msg.answer !== null) link.send({ type: 'reply', id: msg.id, text: msg.answer })
      else pending.push(msg.id)
    }
    // The computer closes the ones it no longer knows about.
    if (pending.length) link.send({ type: 'pending', ids: pending })
  }

  _onframe (link, frame) {
    if (frame.type === 'hello') return this._onhello(link, frame)
    if (typeof frame.id !== 'string' || frame.id.length > 64) return

    if (frame.type === 'msg') this._onmessage(link, frame)
    else if (frame.type === 'closed') this._onclosed(frame.id)
  }

  // The computer may have been renamed since pairing.
  _onhello (link, frame) {
    const name = typeof frame.name === 'string' ? frame.name.slice(0, 64) : ''
    if (!name || name === link.peer.name) return

    link.peer.name = name
    this.save()
    this._emitState()
  }

  _onmessage (link, incoming) {
    // The computer resends after a dropped connection, so the id may be known.
    let msg = this.findMessage(incoming.id)

    if (!msg) {
      msg = {
        id: incoming.id,
        from: link.peer.publicKey,
        fromName: link.peer.name,
        title: str(incoming.title, 200),
        body: str(incoming.body, 4000),
        actions: Array.isArray(incoming.actions) ? incoming.actions.slice(0, 3).map((a) => str(a, 40)) : [],
        wantsReply: incoming.wantsReply === true,
        receivedAt: Date.now(),
        answer: null,
        answeredAt: null,
        closed: false
      }

      this.state.messages.unshift(msg)
      this.state.messages.length = Math.min(this.state.messages.length, MAX_MESSAGES)
      this.save()
      this.emit({ type: 'message', message: msg })
    }

    link.send({ type: 'ack', id: msg.id })
    if (msg.answer !== null && !msg.closed) link.send({ type: 'reply', id: msg.id, text: msg.answer })
  }

  _onclosed (id) {
    const msg = this.findMessage(id)
    if (!msg || msg.closed) return

    msg.closed = true
    this.save()
    this.emit({ type: 'updated', message: msg })
  }
}

// One long-lived connection to one paired computer, redialed with backoff.
class Link {
  constructor (phone, peer) {
    this.phone = phone
    this.peer = peer
    this.conn = null
    this.connected = false
    this.closing = false
    this.delay = MIN_RETRY
    this.timer = null
    this.wake = null
  }

  send (frame) {
    if (this.connected) writeJSON(this.conn, frame)
  }

  kick () {
    this.delay = MIN_RETRY
    if (this.wake) this.wake()
  }

  close () {
    this.closing = true
    if (this.conn) this.conn.destroy()
    if (this.wake) this.wake()
  }

  async run () {
    const { phone, peer } = this

    while (!this.closing) {
      const conn = phone.dht.connect(fromHex(peer.publicKey), { keyPair: phone.keyPair })
      conn.on('error', noop)
      this.conn = conn

      try {
        await opened(conn)
        if (this.closing) break

        this.connected = true
        this.delay = MIN_RETRY
        onJSON(conn, (frame) => phone._onframe(this, frame))
        writeJSON(conn, { type: 'hello' })
        phone._onopen(this)

        await new Promise((resolve) => conn.once('close', resolve))
      } catch {
        // Computer offline or unreachable; try again below.
      } finally {
        conn.destroy()
        this.conn = null
        if (this.connected) {
          this.connected = false
          if (!this.closing) phone._emitState()
        }
      }

      if (this.closing) break
      await new Promise((resolve) => {
        this.wake = resolve
        this.timer = setTimeout(resolve, this.delay)
      })
      clearTimeout(this.timer)
      this.wake = null
      this.delay = Math.min(this.delay * 2, MAX_RETRY)
    }
  }
}

function str (value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function noop () {}
