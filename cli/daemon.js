// The computer side. A HyperDHT server on the CLI's key pair that paired
// phones keep a connection to. Messages queue here until each phone has them.
import { EventEmitter } from 'node:events'
import { timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { onJSON, writeJSON } from '../shared/lines.js'
import { encodePairCode, toHex } from '../shared/protocol.js'

const HELLO_TIMEOUT = 15_000
export const SEND_TTL = 24 * 60 * 60 * 1000

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

  // Queue a message for some devices. The returned emitter fires
  // 'delivered' (device) and 'reply' ({ text, device }).
  send ({ message, targets, ttl = SEND_TTL }) {
    const id = toHex(crypto.randomBytes(8))
    const entry = new EventEmitter()
    entry.id = id
    entry.frame = { type: 'msg', id, ...message }
    entry.wantsReply = message.wantsReply === true
    entry.targets = new Set(targets.map((d) => d.publicKey))
    entry.delivered = new Set()
    entry.timer = setTimeout(() => this.close(id), ttl)

    this.messages.set(id, entry)
    for (const publicKey of entry.targets) {
      const conn = this.conns.get(publicKey)
      if (conn) writeJSON(conn, entry.frame)
    }
    return entry
  }

  // Forget a message and tell the phones nobody waits for it.
  close (id) {
    const entry = this.messages.get(id)
    if (!entry) return
    this.messages.delete(id)
    clearTimeout(entry.timer)

    if (!entry.wantsReply) return
    for (const publicKey of entry.targets) {
      const conn = this.conns.get(publicKey)
      if (conn) writeJSON(conn, { type: 'closed', id })
    }
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
        this._attach(device, conn)
      } else if (frame.type === 'ack') {
        this._onack(device, frame.id)
      } else if (frame.type === 'reply') {
        this._onreply(device, conn, frame.id, frame.text)
      } else if (frame.type === 'pending' && Array.isArray(frame.ids)) {
        // Questions the phone still shows as open, but that we lost (restart).
        for (const id of frame.ids.slice(0, 500)) {
          if (!this.messages.has(id)) writeJSON(conn, { type: 'closed', id })
        }
      }
    })
  }

  _attach (device, conn) {
    const old = this.conns.get(device.publicKey)
    this.conns.set(device.publicKey, conn)
    if (old && old !== conn) old.destroy()
    this.emit('connect', device)

    writeJSON(conn, { type: 'hello', name: this.name })

    for (const entry of this.messages.values()) {
      if (entry.targets.has(device.publicKey) && !entry.delivered.has(device.publicKey)) {
        writeJSON(conn, entry.frame)
      }
    }
  }

  _onack (device, id) {
    const entry = this.messages.get(id)
    if (!entry || entry.delivered.has(device.publicKey)) return

    entry.delivered.add(device.publicKey)
    entry.emit('delivered', device)

    if (!entry.wantsReply && entry.delivered.size === entry.targets.size) this.close(id)
  }

  _onreply (device, conn, id, text) {
    const entry = this.messages.get(id)

    // Expired, answered elsewhere, or from before a restart: stop the resends.
    if (!entry || !entry.wantsReply) {
      writeJSON(conn, { type: 'closed', id })
      return
    }

    entry.emit('reply', { text: String(text), device })
    this.close(id)
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

    clearTimeout(pairing.timer)
    this.pairing = null
    writeJSON(conn, { type: 'paired', name: this.name })
    conn.end()
    pairing.resolve(device)
  }
}

function noop () {}
