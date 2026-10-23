// CLI identity and paired devices, kept in ~/.config/pearbell/config.json
// (or $PEARBELL_HOME/config.json).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'hypercore-crypto'
import DHT from 'hyperdht'
import { toHex, fromHex } from '../shared/protocol.js'

export function home () {
  return process.env.PEARBELL_HOME || path.join(os.homedir(), '.config', 'pearbell')
}

export function load () {
  const file = path.join(home(), 'config.json')
  let config = {}

  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  if (!config.seed) {
    config.seed = toHex(crypto.randomBytes(32))
    config.devices = []
    save(config)
  }

  config.devices ||= []
  return config
}

export function save (config) {
  const dir = home()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const file = path.join(dir, 'config.json')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function keyPair (config) {
  return DHT.keyPair(fromHex(config.seed))
}

// Match a device by name, or by a prefix of its public key.
export function findDevices (config, query) {
  if (!query) return config.devices
  const q = query.toLowerCase()
  return config.devices.filter((d) => d.name.toLowerCase() === q || d.publicKey.startsWith(q))
}

// The name phones show for this computer: "Ilya's MacBook Pro" on macOS.
export function computerName () {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim()
      if (name) return name
    } catch {}
  }
  return os.hostname().replace(/\.local$/, '')
}
