// Wire protocol shared by the computer daemon and the phone.
//
// The computer runs a HyperDHT server on its key pair. The phone always
// dials out to it and keeps the connection open, because phones often sit
// behind NATs that cannot take incoming connections.
//
// Pairing (the first frame on a connection from an unknown phone):
//   phone -> computer  { type: 'pair', token, name }
//   computer -> phone  { type: 'paired', name }  or  { type: 'error', error }
//
// After that, on every connection:
//   phone -> computer  { type: 'hello' }
//   computer -> phone  { type: 'msg', id, title, body, actions, wantsReply }
//   phone -> computer  { type: 'ack', id }
//   phone -> computer  { type: 'reply', id, text }
//   computer -> phone  { type: 'closed', id }   nobody waits for a reply any more
import b4a from 'b4a'
import z32 from 'z32'

export const PAIR_PREFIX = 'pearbell1'

export function encodePairCode (publicKey, token) {
  return `${PAIR_PREFIX}:${z32.encode(publicKey)}:${b4a.toString(token, 'hex')}`
}

export function decodePairCode (code) {
  const parts = String(code).trim().split(':')
  if (parts.length !== 3 || parts[0] !== PAIR_PREFIX) {
    throw new Error('Not a pearbell pairing code')
  }

  const publicKey = z32.decode(parts[1])
  const token = b4a.from(parts[2], 'hex')
  if (publicKey.byteLength !== 32 || token.byteLength !== 16) {
    throw new Error('Damaged pairing code')
  }

  return { publicKey, token }
}

export function toHex (buf) {
  return b4a.toString(buf, 'hex')
}

export function fromHex (str) {
  return b4a.from(str, 'hex')
}

// Resolves when a NoiseSecretStream from hyperdht is open, rejects on failure.
export async function opened (conn) {
  let error = null
  const onerror = (err) => { error = err }
  conn.on('error', onerror)

  const ok = await conn.opened
  conn.off('error', onerror)

  if (!ok) throw error || new Error('Connection failed')
}
