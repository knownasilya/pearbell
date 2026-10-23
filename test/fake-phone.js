// A stand-in for the Android app, on the real DHT. Handy to try the CLI.
//
//   node test/fake-phone.js pair <code>     pair with `pearbell pair`
//   node test/fake-phone.js                 listen; type a reply and press enter
//
// FAKE_PHONE_AUTO=<text> answers every question with <text> at once.
// State lives in $FAKE_PHONE_HOME (default ./.fake-phone).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import DHT from 'hyperdht'
import { Phone } from '../shared/phone.js'

const dir = process.env.FAKE_PHONE_HOME || '.fake-phone'
const file = path.join(dir, 'state.json')
fs.mkdirSync(dir, { recursive: true })

let state = {}
try { state = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}

const dht = new DHT()
const phone = new Phone({
  dht,
  state,
  save: (s) => fs.writeFileSync(file, JSON.stringify(s, null, 2)),
  emit: onevent
})

let last = null

if (process.argv[2] === 'pair') {
  const peer = await phone.pair(process.argv[3], 'fake-phone')
  console.log(`Paired with ${peer.name}`)
  await dht.destroy()
} else {
  await phone.start()
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (last && line.trim()) phone.answer(last.id, line.trim())
  })
}

function onevent (e) {
  if (e.type === 'ready') console.log(`Listening as ${e.publicKey.slice(0, 12)}, ${e.peers.length} paired CLI(s)`)
  if (e.type === 'message') {
    const m = e.message
    console.log(`\n[${m.fromName}] ${m.title ? m.title + ': ' : ''}${m.body}`)
    if (m.actions.length) console.log(`  actions: ${m.actions.join(' | ')}`)
    if (m.wantsReply) {
      last = m
      if (process.env.FAKE_PHONE_AUTO) phone.answer(m.id, process.env.FAKE_PHONE_AUTO)
      else console.log('  type a reply:')
    }
  }
  if (e.type === 'updated' && e.message.closed && e.message.answer === null) console.log(`  (${e.message.id} no longer waiting)`)
}
