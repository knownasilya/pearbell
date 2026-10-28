// The computer side. A HyperDHT server on the CLI's key pair that paired
// phones keep a connection to. Messages queue here until each phone has them.
// The macOS menu bar app, when it runs, connects over the local socket and
// gets every message too; router.js decides which side shows it.
import { EventEmitter } from 'node:events'
import { timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { onJSON, writeJSON } from '../shared/lines.js'
import { MAX_SAY, encodePairCode, toHex } from '../shared/protocol.js'
import { awayReason, decide, idleSeconds, snoozeReason } from './router.js'

const HELLO_TIMEOUT = 15_000
export const SEND_TTL = 24 * 60 * 60 * 1000
// What the user writes to a topic nobody listens to waits this long, up to
// INBOX_MAX per topic, for pearbell inbox.
const INBOX_TTL = 60 * 60 * 1000
const INBOX_MAX = 20

// The menu bar app's place in a message's targets, next to phone keys.
export const MAC = 'mac'
const MAC_DEVICE = { publicKey: MAC, name: 'this Mac', mac: true }

export class Daemon extends EventEmitter {
  constructor ({ dht, keyPair, devices = [], name = os.hostname() }) {
    super()
    this.dht = dht
    this.keyPair = keyPair
    this.devices = devices
    this.name = name
    this.server = null
    this.conns = new Map()
    this.messages = new Map()
    this.pairing = null
    this.mac = null // { conn, presence } while the menu bar app is connected
    this.listeners = new Set() // { topics, write } for each listen on the local socket
    this.heard = new Map() // say id -> { listeners, queued }, so a resend is not passed on twice
    this.inbox = new Map() // topic -> says nobody listened to yet, for pearbell inbox
  }

  async start () {
    this.server = this.dht.createServer({
      firewall: (remotePublicKey) => !this.pairing && !this.findDevice(toHex(remotePublicKey))
    }, (conn) => this._onconnection(conn))

    await this.server.listen(this.keyPair)
  }

  async stop () {
    this.cancelPairing()
    // Nobody can collect a reply after this, so let the phones know.
    for (const id of [...this.messages.keys()]) this.close(id)
    for (const conn of this.conns.values()) conn.destroy()
    if (this.mac) this.mac.conn.destroy()
    if (this.server) await this.server.close()
  }

  findDevice (publicKey) {
    return this.devices.find((d) => d.publicKey === publicKey) || null
  }

  isConnected (publicKey) {
    return this.conns.has(publicKey)
  }

  // The device list changed on disk (pearbell unpair).
  setDevices (devices) {
    this.devices = devices
    for (const [publicKey, conn] of this.conns) {
      if (!this.findDevice(publicKey)) conn.destroy()
    }
    this._macState()
  }

  // What the router knows about the Mac: null when the app is not running.
  presence () {
    return this.mac ? (this.mac.presence || {}) : null
  }

  // Names of the places a message goes to, phones and the Mac.
  targetsOf (entry) {
    return [...entry.targets].map((key) => key === MAC ? MAC_DEVICE : this.findDevice(key)).filter(Boolean)
  }

  isTargetConnected (key) {
    return key === MAC ? this.mac !== null : this.isConnected(key)
  }

  // Accept one phone that shows the token. Returns the code to show the user.
  startPairing (timeout) {
    this.cancelPairing()

    const token = crypto.randomBytes(16)
    let resolve, reject
    const done = new Promise((res, rej) => { resolve = res; reject = rej })
    const timer = setTimeout(() => {
      this.pairing = null
      reject(Object.assign(new Error('No phone paired in time'), { code: 'TIMEOUT' }))
    }, timeout)

    this.pairing = { token, resolve, reject, timer }
    return { code: encodePairCode(this.keyPair.publicKey, token), done }
  }

  cancelPairing () {
    if (!this.pairing) return
    clearTimeout(this.pairing.timer)
    this.pairing.reject(new Error('Pairing cancelled'))
    this.pairing = null
  }

  // Queue a message for some phones, or the Mac (see router.js). The returned
  // emitter fires 'delivered' (device), 'reply' ({ text, device }) and
  // 'routed' ({ to, reason }) when a question moves on to the phones.
  send ({ message, targets, ttl = SEND_TTL, route = 'auto' }) {
    const id = toHex(crypto.randomBytes(8))
    const entry = new EventEmitter()
    entry.id = id
    entry.frame = { type: 'msg', id, ...message }
    entry.wantsReply = message.wantsReply === true
    entry.phones = targets
    entry.targets = new Set()
    entry.delivered = new Set()
    entry.sentAt = Date.now()
    entry.timer = setTimeout(() => this.close(id), ttl)
    entry.route = decide({
      wantsReply: entry.wantsReply,
      route,
      presence: this.presence(),
      phones: targets.map((d) => ({ connected: this.isConnected(d.publicKey) }))
    })

    this.messages.set(id, entry)
    if (entry.route.to !== 'mac') this._addPhones(entry)
    if (entry.route.to !== 'phone' && this.mac) entry.targets.add(MAC)
    // The Mac keeps a copy of everything for its inbox, shown quietly when
    // the message went to the phone.
    if (this.mac) this._toMac(entry)
    if (entry.route.escalateAfter) {
      entry.escalation = setTimeout(() => this.escalate(id, 'no answer on the Mac yet'), entry.route.escalateAfter)
    }
    return entry
  }

  // Send a message routed to the Mac on to the phones as well.
  escalate (id, reason) {
    const entry = this.messages.get(id)
    if (!entry) return
    clearTimeout(entry.escalation)
    if (!this._addPhones(entry).length) return

    entry.route = { to: entry.targets.has(MAC) ? 'both' : 'phone', reason, escalateAfter: null }
    entry.emit('routed', entry.route)
    this._writeMac({ type: 'routed', id, to: entry.route.to, reason })
  }

  // Forget a message and tell the phones nobody waits for it.
  close (id, answer = null) {
    const entry = this.messages.get(id)
    if (!entry) return
    this.messages.delete(id)
    clearTimeout(entry.timer)
    clearTimeout(entry.escalation)

    if (!entry.wantsReply) return
    for (const publicKey of entry.targets) {
      const conn = this.conns.get(publicKey)
      if (conn) writeJSON(conn, { type: 'closed', id })
    }
    this._writeMac({ type: 'closed', id, ...(answer ? { answer: answer.text, device: answer.device.name } : {}) })
  }

  // The menu bar app connected over the local socket. Only one at a time.
  attachMac (conn, presence) {
    if (this.mac) this.mac.conn.destroy()
    const mac = { conn, presence: null }
    this.mac = mac
    this.setPresence(presence)

    conn.on('close', () => {
      if (this.mac !== mac) return
      this.mac = null
      this.emit('mac', false)
      // Whatever was waiting on the Mac goes to the phones now.
      for (const entry of [...this.messages.values()]) {
        if (entry.shownAt) {
          this.close(entry.id)
          continue
        }
        if (!entry.targets.has(MAC) || entry.delivered.has(MAC) && !entry.wantsReply) continue
        if (!entry.delivered.has(MAC)) entry.targets.delete(MAC)
        this.escalate(entry.id, 'the menu bar app quit')
        if (!entry.wantsReply && entry.delivered.size === entry.targets.size) this.close(entry.id)
      }
    })

    this.emit('mac', true)
    this._macState()
    // Questions still open show up in the app's inbox again; the app closes
    // the ones it shows that we no longer know (a daemon restart).
    const open = []
    for (const entry of this.messages.values()) {
      if (!entry.wantsReply) continue
      this._toMac(entry)
      open.push(entry.id)
    }
    this._writeMac({ type: 'synced', open })
  }

  // A frame from the menu bar app: presence, ack or reply.
  onMacFrame (conn, frame) {
    if (!this.mac || this.mac.conn !== conn) return
    if (frame.type === 'presence') this.setPresence(frame)
    else if (frame.type === 'ack') this._onack(MAC_DEVICE, String(frame.id))
    else if (frame.type === 'reply') this._onreply(MAC_DEVICE, null, String(frame.id), frame.text)
  }

  setPresence (p = {}) {
    if (!this.mac) return
    const num = (v) => Number.isFinite(v) && v >= 0 ? v : undefined
    this.mac.presence = {
      idle: num(p.idle) ?? 0,
      locked: p.locked === true,
      asleep: p.asleep === true,
      mode: ['auto', 'mac', 'phone'].includes(p.mode) ? p.mode : 'auto',
      idleAfter: num(p.idleAfter),
      escalateAfter: num(p.escalateAfter),
      snoozedUntil: num(p.snoozedUntil),
      at: Date.now()
    }

    // Stepped away with a question open on the Mac, or before you touched the
    // Mac after a message showed there: hand it to the phones.
    const presence = this.mac.presence
    const away = snoozeReason(presence) || (presence.mode === 'mac'
      ? null
      : presence.mode === 'phone' ? 'set to Always phone' : awayReason(presence))
    const now = Date.now()
    for (const entry of [...this.messages.values()]) {
      if (entry.shownAt) {
        const seen = idleSeconds(presence, now) < (now - entry.shownAt) / 1000
        if (seen || !away && presence.mode === 'mac') this.close(entry.id)
        else if (away) this._follow(entry, away)
      } else if (away && entry.wantsReply && entry.targets.has(MAC)) {
        this.escalate(entry.id, away)
      }
    }
  }

  // Hear what the user writes to these topics on a phone (pearbell mcp
  // --channel, pearbell listen). write gets { type: 'said', id, topic, text,
  // device }. Returns a function that stops listening.
  // What waited in the inbox for these topics goes to the new listener first.
  listen (topics, write) {
    const listener = { topics: new Set(topics), write }
    this.listeners.add(listener)
    for (const topic of topics) {
      for (const said of this.takeInbox(topic)) write(said)
    }
    return () => this.listeners.delete(listener)
  }

  // Take what the user wrote to a topic while nothing listened (pearbell inbox,
  // from a Claude Code hook). The phone hears that a session got each one.
  takeInbox (topic) {
    const now = Date.now()
    const waiting = (this.inbox.get(topic) || []).filter((s) => now - s.at < INBOX_TTL)
    this.inbox.delete(topic)

    for (const said of waiting) {
      this.heard.set(said.id, { listeners: 1, queued: false })
      const conn = this.conns.get(said.from)
      if (conn) writeJSON(conn, { type: 'heard', id: said.id, listeners: 1 })
    }
    return waiting.map(({ from, ...said }) => said)
  }

  listening (topic) {
    return [...this.listeners].filter((l) => l.topics.has(topic))
  }

  // Add the message's phones to its targets and send it to those online.
  _addPhones (entry) {
    const added = entry.phones.filter((d) => !entry.targets.has(d.publicKey))
    for (const d of added) {
      entry.targets.add(d.publicKey)
      const conn = this.conns.get(d.publicKey)
      if (conn) writeJSON(conn, entry.frame)
    }
    return added
  }

  _toMac (entry) {
    this._writeMac({
      ...entry.frame,
      notify: entry.targets.has(MAC) && !entry.delivered.has(MAC),
      route: { to: entry.route.to, reason: entry.route.reason },
      sentAt: entry.sentAt
    })
  }

  _writeMac (frame) {
    if (this.mac) writeJSON(this.mac.conn, frame)
  }

  _macState () {
    this._writeMac({
      type: 'state',
      computer: this.name,
      devices: this.devices.map((d) => ({ name: d.name, publicKey: d.publicKey, connected: this.isConnected(d.publicKey) }))
    })
  }

  _onconnection (conn) {
    const publicKey = toHex(conn.remotePublicKey)
    const timer = setTimeout(() => conn.destroy(), HELLO_TIMEOUT)

    conn.on('error', noop)
    conn.on('close', () => {
      clearTimeout(timer)
      if (this.conns.get(publicKey) !== conn) return
      this.conns.delete(publicKey)
      this.emit('disconnect', this.findDevice(publicKey))
      this._macState()
    })

    onJSON(conn, (frame) => {
      if (frame.type === 'pair') {
        clearTimeout(timer)
        return this._onpair(conn, publicKey, frame)
      }

      const device = this.findDevice(publicKey)
      if (!device) return conn.destroy()

      if (frame.type === 'hello') {
        clearTimeout(timer)
        this._rename(device, frame.name)
        this._attach(device, conn)
      } else if (frame.type === 'name') {
        this._rename(device, frame.name)
      } else if (frame.type === 'ack') {
        this._onack(device, frame.id)
      } else if (frame.type === 'reply') {
        this._onreply(device, conn, frame.id, frame.text)
      } else if (frame.type === 'say') {
        this._onsay(device, conn, frame)
      } else if (frame.type === 'pending' && Array.isArray(frame.ids)) {
        // Questions the phone still shows as open, but that we lost (restart).
        for (const id of frame.ids.slice(0, 500)) {
          if (!this.messages.has(id)) writeJSON(conn, { type: 'closed', id })
        }
      }
    })
  }

  // The phone was renamed in its app.
  _rename (device, name) {
    const clean = typeof name === 'string' ? name.trim().slice(0, 64) : ''
    if (!clean || clean === device.name) return
    device.name = clean
    this.emit('devices', this.devices)
    this._macState()
  }

  _attach (device, conn) {
    const old = this.conns.get(device.publicKey)
    this.conns.set(device.publicKey, conn)
    if (old && old !== conn) old.destroy()
    this.emit('connect', device)
    this._macState()

    writeJSON(conn, { type: 'hello', name: this.name })

    for (const entry of this.messages.values()) {
      if (entry.targets.has(device.publicKey) && !entry.delivered.has(device.publicKey)) {
        writeJSON(conn, entry.frame)
      }
    }
  }

  _onack (device, id) {
    const entry = this.messages.get(id)
    // The Mac acks its quiet copies too; only count it where it was a target.
    if (!entry || !entry.targets.has(device.publicKey) || entry.delivered.has(device.publicKey)) return

    entry.delivered.add(device.publicKey)
    entry.emit('delivered', device)

    if (entry.wantsReply || entry.delivered.size < entry.targets.size) return
    // Shown on the Mac while you use it: keep it until you touch the Mac again
    // (seen) or step away (it goes to the phones), see setPresence.
    if (entry.route.follow && device === MAC_DEVICE) entry.shownAt = Date.now()
    else this.close(id)
  }

  // A message you have not seen on the Mac goes on to the phones.
  _follow (entry, reason) {
    entry.shownAt = null
    this.escalate(entry.id, `not seen on the Mac, ${reason}`)
    if (entry.delivered.size === entry.targets.size) this.close(entry.id)
  }

  _onreply (device, conn, id, text) {
    const entry = this.messages.get(id)

    // Expired, answered elsewhere, or from before a restart: stop the resends.
    if (!entry || !entry.wantsReply) {
      writeJSON(conn || this.mac.conn, { type: 'closed', id })
      return
    }

    const answer = { text: String(text), device }
    entry.emit('reply', answer)
    this.close(id, answer)
  }

  // The user wrote to a topic on the phone: pass it to whatever listens there.
  _onsay (device, conn, frame) {
    const id = typeof frame.id === 'string' && frame.id.length <= 64 ? frame.id : ''
    const topic = typeof frame.topic === 'string' ? frame.topic.trim().slice(0, 40) : ''
    const text = typeof frame.text === 'string' ? frame.text.trim().slice(0, MAX_SAY) : ''
    if (!id || !topic || !text) return

    let heard = this.heard.get(id)
    if (heard === undefined) {
      const said = { type: 'said', id, topic, text, device: device.name, at: Date.now() }
      const reached = this.listening(topic)
      for (const l of reached) l.write(said)

      // Nothing listens now: keep it for pearbell inbox (a Claude Code hook).
      if (!reached.length) {
        const waiting = (this.inbox.get(topic) || []).concat({ ...said, from: device.publicKey })
        this.inbox.set(topic, waiting.slice(-INBOX_MAX))
      }

      heard = { listeners: reached.length, queued: !reached.length }
      this.heard.set(id, heard)
      if (this.heard.size > 500) this.heard.delete(this.heard.keys().next().value)
      this.emit('said', { ...said, ...heard })
    }
    writeJSON(conn, { type: 'heard', id, ...heard })
  }

  _onpair (conn, publicKey, frame) {
    const pairing = this.pairing
    const given = b4a.from(String(frame.token), 'hex')

    if (!pairing || given.byteLength !== pairing.token.byteLength || !timingSafeEqual(given, pairing.token)) {
      writeJSON(conn, { type: 'error', error: pairing ? 'Wrong pairing code' : 'The computer is not pairing right now' })
      conn.end()
      return
    }

    const device = {
      publicKey,
      name: String(frame.name || 'phone').slice(0, 64),
      pairedAt: Date.now()
    }

    this.devices = this.devices.filter((d) => d.publicKey !== publicKey).concat(device)
    this.emit('devices', this.devices)
    this._macState()

    clearTimeout(pairing.timer)
    this.pairing = null
    writeJSON(conn, { type: 'paired', name: this.name })
    conn.end()
    pairing.resolve(device)
  }
}

function noop () {}
