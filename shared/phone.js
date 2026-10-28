// The phone side of pearbell. It runs inside the Android app's Bare worklet,
// and in Node for tests and for test/fake-phone.js.
//
// For each paired computer the phone keeps one outgoing connection open and
// redials when it drops. The host (Android or a test) gives it a plain JSON
// state object and a save() function, and gets events through emit().
import DHT from 'hyperdht'
import crypto from 'hypercore-crypto'
import { onJSON, writeJSON } from './lines.js'
import { MAX_SAY, cleanKey, clipBody, decodePairCode, opened, toHex, fromHex } from './protocol.js'

const MAX_MESSAGES = 200
const MAX_TOPIC = 40
const PAIR_TIMEOUT = 30_000
const MIN_RETRY = 1_000
const MAX_RETRY = 30_000
// A say the computer never heard is resent on reconnect for this long.
const SAY_TTL = 24 * 60 * 60 * 1000

export class Phone {
  constructor ({ dht, state = {}, save = noop, emit = noop, name = '' }) {
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
    this.name = cleanName(name)
    this.trash = [] // recently deleted messages, for undo
    this.cleared = [] // the last "Clear all", for undo
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
  // The name paired computers show for this phone.
  setName (name) {
    const clean = cleanName(name)
    if (!clean || clean === this.name) return
    this.name = clean
    for (const link of this.links.values()) link.send({ type: 'name', name: clean })
  }

  async pair (code, name = this.name) {
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
        writeJSON(conn, { type: 'pair', token: toHex(token), name: cleanName(name) || 'phone' })
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

  archive (id, archived = true) {
    const msg = this.findMessage(id)
    if (!msg || msg.archived === archived) return false

    msg.archived = archived
    this.save()
    this.emit({ type: 'updated', message: msg })
    return true
  }

  delete (id) {
    const i = this.state.messages.findIndex((m) => m.id === id)
    if (i === -1) return false

    const [msg] = this.state.messages.splice(i, 1)
    this.trash.unshift(msg)
    this.trash.length = Math.min(this.trash.length, 20)
    this.save()
    this._emitState()
    return true
  }

  undelete (id) {
    const i = this.trash.findIndex((m) => m.id === id)
    if (i === -1 || this.findMessage(id)) return false

    const [msg] = this.trash.splice(i, 1)
    this.state.messages.push(msg)
    this.state.messages.sort((a, b) => b.receivedAt - a.receivedAt)
    this.save()
    this._emitState()
    return true
  }

  // Delete many at once ("Clear all"). The batch is kept apart from the trash,
  // which only holds a few, so one undo brings all of it back.
  deleteAll (ids) {
    const drop = new Set(ids)
    const removed = this.state.messages.filter((m) => drop.has(m.id))
    if (!removed.length) return 0

    this.state.messages = this.state.messages.filter((m) => !drop.has(m.id))
    this.cleared = removed
    this.save()
    this._emitState()
    return removed.length
  }

  undeleteAll () {
    const back = this.cleared.filter((m) => !this.findMessage(m.id))
    this.cleared = []
    if (!back.length) return 0

    this.state.messages.push(...back)
    this.state.messages.sort((a, b) => b.receivedAt - a.receivedAt)
    this.save()
    this._emitState()
    return back.length
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

  // Computers that sent messages under a topic, so they can take a say.
  topicPeers (topic) {
    const keys = new Set()
    for (const m of this.state.messages) {
      if (!m.mine && m.topic === topic) keys.add(m.from)
    }
    return this.state.peers.filter((p) => keys.has(p.publicKey))
  }

  // The user wrote to a topic. It goes to each computer that sent messages
  // under it, and shows in the inbox as the user's own message. Returns it,
  // or null when no paired computer uses the topic.
  say (topic, text) {
    const clean = str(topic, MAX_TOPIC).trim()
    const body = str(text, MAX_SAY).trim()
    const peers = clean ? this.topicPeers(clean) : []
    if (!body || !peers.length) return null

    const msg = {
      id: toHex(crypto.randomBytes(8)),
      key: null,
      mine: true,
      from: '',
      fromName: '',
      to: peers.map((p) => ({ publicKey: p.publicKey, name: p.name, heard: null })),
      title: '',
      body,
      topic: clean,
      actions: [],
      wantsReply: false,
      receivedAt: Date.now(),
      answer: null,
      answeredAt: null,
      closed: false,
      archived: false,
      updatedAt: null,
      updates: 0
    }

    this.state.messages.unshift(msg)
    this.state.messages.length = Math.min(this.state.messages.length, MAX_MESSAGES)
    this.save()
    this.emit({ type: 'updated', message: msg })

    // A computer that is offline gets it when it reconnects (see _onopen).
    for (const p of peers) this.links.get(p.publicKey)?.send(sayFrame(msg))
    return msg
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

    // What the user wrote to a topic while the computer was away.
    const now = Date.now()
    for (const msg of this.state.messages) {
      if (!msg.mine || now - msg.receivedAt > SAY_TTL) continue
      if (msg.to.some((t) => t.publicKey === link.peer.publicKey && t.heard === null)) link.send(sayFrame(msg))
    }
  }

  _onframe (link, frame) {
    if (frame.type === 'hello') return this._onhello(link, frame)
    if (typeof frame.id !== 'string' || frame.id.length > 64) return

    if (frame.type === 'msg') this._onmessage(link, frame)
    else if (frame.type === 'closed') this._onclosed(frame.id)
    else if (frame.type === 'heard') this._onheard(link, frame)
  }

  // The computer passed a say on to this many listeners, or queued it for a
  // session to take later (another heard follows then).
  _onheard (link, frame) {
    const msg = this.findMessage(frame.id)
    const to = msg?.mine ? msg.to.find((t) => t.publicKey === link.peer.publicKey) : null
    if (!to) return

    to.heard = Number.isInteger(frame.listeners) && frame.listeners > 0 ? frame.listeners : 0
    to.queued = to.heard === 0 && frame.queued === true
    this.save()
    this.emit({ type: 'updated', message: msg })
  }

  // The computer may have been renamed since pairing.
  _onhello (link, frame) {
    const name = typeof frame.name === 'string' ? frame.name.slice(0, 64) : ''
    if (!name || name === link.peer.name) return

    link.peer.name = name
    this.save()
    this._emitState()
  }

  // The newest message from this computer with the sender's id.
  findByKey (from, key) {
    return this.state.messages.find((m) => m.from === from && m.key === key) || null
  }

  _onmessage (link, incoming) {
    const key = cleanKey(incoming.key)
    const edits = incoming.update === true && key ? this.findByKey(link.peer.publicKey, key) : null
    if (edits) return this._onupdate(link, incoming, edits)

    // The computer resends after a dropped connection, so the id may be known.
    let msg = this.findMessage(incoming.id)

    if (!msg) {
      msg = {
        id: incoming.id,
        key: key || null,
        from: link.peer.publicKey,
        fromName: link.peer.name,
        title: str(incoming.title, 200),
        body: clipBody(str(incoming.body, Infinity)),
        topic: str(incoming.topic, MAX_TOPIC).trim(),
        actions: Array.isArray(incoming.actions) ? incoming.actions.slice(0, 3).map((a) => str(a, 40)) : [],
        wantsReply: incoming.wantsReply === true,
        receivedAt: Date.now(),
        answer: null,
        answeredAt: null,
        closed: false,
        archived: false,
        updatedAt: null,
        updates: 0
      }

      this.state.messages.unshift(msg)
      this.state.messages.length = Math.min(this.state.messages.length, MAX_MESSAGES)
      this.save()
      this.emit({ type: 'message', message: msg })
    }

    link.send({ type: 'ack', id: msg.id })
    if (msg.answer !== null && !msg.closed) link.send({ type: 'reply', id: msg.id, text: msg.answer })
  }

  // An update for a message we have: new text in place, no new notification.
  _onupdate (link, incoming, msg) {
    // A resend of the last update (its ack got lost) changes nothing.
    if (msg.lastUpdate === incoming.id) return link.send({ type: 'ack', id: incoming.id })

    const title = str(incoming.title, 200)
    const topic = str(incoming.topic, MAX_TOPIC).trim()
    msg.body = clipBody(str(incoming.body, Infinity))
    if (title) msg.title = title
    if (topic) msg.topic = topic
    msg.updatedAt = Date.now()
    msg.updates = (msg.updates || 0) + 1
    msg.lastUpdate = incoming.id

    this.save()
    this.emit({ type: 'edited', message: msg })
    link.send({ type: 'ack', id: incoming.id })
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
        writeJSON(conn, { type: 'hello', name: phone.name || undefined })
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

function sayFrame (msg) {
  return { type: 'say', id: msg.id, topic: msg.topic, text: msg.body }
}

function cleanName (name) {
  return typeof name === 'string' ? name.trim().slice(0, 64) : ''
}

function str (value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function noop () {}
