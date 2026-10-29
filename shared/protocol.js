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
//   phone -> computer  { type: 'hello', name }   name: its current name
//   phone -> computer  { type: 'name', name }    the phone was renamed
//   computer -> phone  { type: 'hello', name }   its current name
//   phone -> computer  { type: 'pending', ids }   questions it still shows as open
//   computer -> phone  { type: 'msg', id, title, topic, body, actions, wantsReply, key?, update? }
//   phone -> computer  { type: 'ack', id }
//   phone -> computer  { type: 'reply', id, text }
//   computer -> phone  { type: 'closed', id }   nobody waits for a reply any more
//   phone -> computer  { type: 'say', id, topic, text }   the user wrote to a topic
//   phone <-> computer { type: 'rest', rest }   rest hours (shared/rest.js); each
//                      side sends its own when it connects, and after a change.
//                      The newer one (rest.updatedAt) wins; the side with the
//                      newer one answers an older one with its own.
//   computer -> phone  { type: 'heard', id, listeners, queued? }   how many listened
//                      (0: nobody; queued: it waits for pearbell inbox, and
//                      another heard follows when a session takes it)
//
// key is an id the sender picked (pearbell send --id). A msg with update: true
// edits the newest message from the same computer with that key instead of
// adding one: it takes the new body, and the title and topic when given. When
// there is no such message (deleted, or never got it), it shows as a new one.
//
// say goes to whatever listens on that topic on the computer, such as a
// Claude Code session running pearbell mcp --channel. The answer, if any,
// comes back as an ordinary msg on the same topic. The phone resends a say
// until it hears back, so the computer answers a repeated id without passing
// the text on again. When nothing listens, the computer keeps the say for an
// hour, for a Claude Code hook that runs pearbell inbox.
import b4a from 'b4a'
import z32 from 'z32'

export const PAIR_PREFIX = 'pearbell1'

// Longest message body the phone keeps. A longer one is cut with a note at
// the end, so it never looks complete when it is not.
export const MAX_BODY = 16_000

export function clipBody (body) {
  if (body.length <= MAX_BODY) return body
  const keep = MAX_BODY - 64 // room for the note
  const note = `\n\n… (cut: ${(body.length - keep).toLocaleString('en-US')} more characters)`
  return body.slice(0, keep) + note
}

// Longest text the phone sends to a topic.
export const MAX_SAY = 4_000

// A sender-supplied message id: up to 64 characters, no whitespace.
export const MAX_KEY = 64

export function cleanKey (key) {
  if (typeof key !== 'string') return ''
  const k = key.trim()
  return k.length <= MAX_KEY && !/\s/.test(k) ? k : ''
}

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
