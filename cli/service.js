// Starts the daemon at login and restarts it if it stops: a launch agent on
// macOS, a systemd user service on Linux. While it is installed, the CLI asks
// launchd or systemd to (re)start the daemon instead of spawning one itself,
// so there is never more than one.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as config from './config.js'

export const LABEL = 'dev.pearbell.daemon'
export const UNIT = 'pearbell.service'

const platform = () => process.platform

export function supported () {
  return platform() === 'darwin' || platform() === 'linux'
}

// What to call it in messages: "launch agent" or "systemd user service".
export function kind () {
  return platform() === 'linux' ? 'systemd user service' : 'launch agent'
}

export function file () {
  if (platform() === 'linux') {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    return path.join(base, 'systemd', 'user', UNIT)
  }
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

// Installed for this pearbell home? A PEARBELL_HOME used for tests or a
// second identity gets its own daemon from the CLI, not the service's.
export function installed () {
  if (!supported()) return false
  let text
  try {
    text = fs.readFileSync(file(), 'utf8')
  } catch {
    return false
  }
  const home = platform() === 'linux' ? unitHome(text) : plistHome(text)
  const defaultHome = path.join(os.homedir(), '.config', 'pearbell')
  return path.resolve(home ?? defaultHome) === path.resolve(config.home())
}

export function install (bin) {
  if (!supported()) throw new Error('pearbell service only supports macOS and Linux')
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  if (platform() === 'linux') {
    fs.writeFileSync(file(), unit(program(bin)))
    systemctl(['daemon-reload'])
    systemctl(['enable', UNIT])
    systemctl(['restart', UNIT])
    return
  }
  fs.writeFileSync(file(), plist(program(bin)))
  launchctl(['bootout', target()], { quiet: true })
  launchctl(['bootstrap', `gui/${process.getuid()}`, file()])
}

export function uninstall () {
  if (!installed()) return
  if (platform() === 'linux') {
    systemctl(['disable', '--now', UNIT], { quiet: true })
    fs.rmSync(file(), { force: true })
    systemctl(['daemon-reload'], { quiet: true })
    return
  }
  launchctl(['bootout', target()], { quiet: true })
  fs.rmSync(file(), { force: true })
}

// { installed, running, pid }
export function status () {
  if (!installed()) return { installed: false, running: false, pid: null }
  if (platform() === 'linux') {
    const out = systemctl(['show', UNIT, '-p', 'ActiveState', '-p', 'MainPID'], { quiet: true }) ?? ''
    const pid = Number(/^MainPID=(\d+)/m.exec(out)?.[1]) || null
    return { installed: true, running: /^ActiveState=active/m.test(out), pid }
  }
  const out = launchctl(['print', target()], { quiet: true }) ?? ''
  const pid = Number(/^\s*pid = (\d+)/m.exec(out)?.[1]) || null
  return { installed: true, running: /^\s*state = running/m.test(out), pid }
}

// Start the daemon now; with `restart`, stop the running one first.
export function kickstart ({ restart = false } = {}) {
  if (platform() === 'linux') systemctl([restart ? 'restart' : 'start', UNIT])
  else launchctl(['kickstart', ...(restart ? ['-k'] : []), target()])
}

// The `pearbell` on PATH (survives Node upgrades), else this Node and script.
function program (bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, 'pearbell')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return { args: [candidate, 'daemon'], path: dir }
    } catch {}
  }
  return { args: [process.execPath, bin, 'daemon'], path: path.dirname(process.execPath) }
}

function env (dir) {
  return {
    PATH: [dir, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
    HOME: os.homedir(),
    PEARBELL_HOME: config.home(),
    ...(process.env.VOLTA_HOME ? { VOLTA_HOME: process.env.VOLTA_HOME } : {})
  }
}

// macOS

const target = () => `gui/${process.getuid()}/${LABEL}`

function plistHome (xml) {
  const home = /<key>PEARBELL_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)?.[1]
  return home === undefined ? null : home.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function plist ({ args, path: dir }) {
  const log = path.join(config.home(), 'daemon.log')
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env(dir)).map(([k, v]) => `    <key>${k}</key>\n    <string>${x(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${x(log)}</string>
  <key>StandardErrorPath</key>
  <string>${x(log)}</string>
</dict>
</plist>
`
}

function launchctl (args, { quiet = false } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (quiet) return null
    throw new Error(`launchctl ${args[0]} failed: ${(err.stderr || err.message).trim()}`)
  }
}

// Linux

// A double-quoted systemd word: escape \ and ", and double % (specifiers).
// ExecStart also expands $VARS, so its words double $ too; Environment= doesn't.
const quote = (s, { exec = false } = {}) => {
  const word = String(s).replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')
  return '"' + (exec ? word.replace(/\$/g, '$$$$') : word) + '"'
}
const unquote = (s) => s.replace(/%%/g, '%').replace(/\\(.)/g, '$1')

export function unitHome (text) {
  const home = /^Environment="PEARBELL_HOME=((?:[^"\\]|\\.)*)"$/m.exec(text)?.[1]
  return home === undefined ? null : unquote(home)
}

export function unit ({ args, path: dir }) {
  const log = path.join(config.home(), 'daemon.log')
  // append: paths take no quotes, so a space or % in the path can't be kept.
  const output = /[\s%]/.test(log) ? 'journal' : `append:${log}`
  return `[Unit]
Description=pearbell daemon
After=network-online.target

[Service]
ExecStart=${args.map((a) => quote(a, { exec: true })).join(' ')}
${Object.entries(env(dir)).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join('\n')}
Restart=always
RestartSec=10
StandardOutput=${output}
StandardError=${output}

[Install]
WantedBy=default.target
`
}

function systemctl (args, { quiet = false } = {}) {
  try {
    return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (quiet) return null
    throw new Error(`systemctl --user ${args[0]} failed: ${(err.stderr || err.message).trim()}`)
  }
}
