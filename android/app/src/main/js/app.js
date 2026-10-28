/* global Bare, BareKit */
// Entry point of the Bare worklet inside the Android app. It runs the shared
// phone core and talks to the Kotlin side over Bare Kit IPC with
// newline-delimited JSON.
//
// Kotlin -> worklet: init, pair, answer, unpair, clear, archive, delete, undelete,
// delete-all, undelete-all, rename
// worklet -> Kotlin: ready, state, message, updated, edited, paired, pair-error, error
// (edited: the sender changed a message with an update, see shared/protocol.js)
import fs from 'bare-fs'
import path from 'bare-path'
import DHT from 'hyperdht'
import { Phone } from '../../../../../shared/phone.js'
import { onJSON, writeJSON } from '../../../../../shared/lines.js'

let ipc = null
let phone = null

// A thrown error would take the whole app down, so report it instead.
Bare.on('uncaughtException', (err) => report(err))
Bare.on('unhandledRejection', (err) => report(err))

waitForIPC().then((stream) => {
  ipc = stream
  onJSON(ipc, (cmd) => {
    oncommand(cmd).catch(report)
  })
})

async function oncommand (cmd) {
  switch (cmd.type) {
    case 'init': return init(cmd)
    case 'pair':
      try {
        await phone.pair(cmd.code, cmd.name)
      } catch (err) {
        send({ type: 'pair-error', error: err.message })
      }
      return
    case 'answer': return phone.answer(cmd.id, cmd.text)
    case 'unpair': return phone.unpair(cmd.publicKey)
    case 'clear': return phone.clear()
    case 'archive': return phone.archive(cmd.id, cmd.archived !== false)
    case 'delete': return phone.delete(cmd.id)
    case 'undelete': return phone.undelete(cmd.id)
    case 'delete-all': return phone.deleteAll(Array.isArray(cmd.ids) ? cmd.ids : [])
    case 'undelete-all': return phone.undeleteAll()
    case 'rename': return phone.setName(cmd.name)
  }
}

async function init ({ dir, name }) {
  if (phone) {
    phone.setName(name)
    send({ type: 'ready', publicKey: phone.publicKey.toString('hex'), ...phone.snapshot() })
    return
  }

  const file = path.join(dir, 'state.json')
  let state = {}
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}

  phone = new Phone({
    dht: new DHT(),
    name,
    state,
    save (s) {
      fs.writeFileSync(file + '.tmp', JSON.stringify(s))
      fs.renameSync(file + '.tmp', file)
    },
    emit: send
  })

  await phone.start()
}

function send (event) {
  if (ipc) writeJSON(ipc, event)
}

function report (err) {
  console.error(err)
  send({ type: 'error', error: String((err && err.stack) || err) })
}

function waitForIPC () {
  return new Promise((resolve) => {
    if (BareKit.IPC) return resolve(BareKit.IPC)
    const timer = setInterval(() => {
      if (!BareKit.IPC) return
      clearInterval(timer)
      resolve(BareKit.IPC)
    }, 10)
  })
}
