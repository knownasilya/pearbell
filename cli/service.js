// macOS launch agent that starts the daemon at login and restarts it if it
// stops. While it is installed, the CLI asks launchd to (re)start the daemon
// instead of spawning one itself, so there is never more than one.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as config from './config.js'

export const LABEL = 'dev.pearbell.daemon'

export function supported () {
  return process.platform === 'darwin'
}

export function plistPath () {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

export function installed () {
  return supported() && fs.existsSync(plistPath())
}

const target = () => `gui/${process.getuid()}/${LABEL}`

export function install (bin) {
  if (!supported()) throw new Error('pearbell service only supports macOS for now')
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true })
  fs.writeFileSync(plistPath(), plist(program(bin)))
  launchctl(['bootout', target()], { quiet: true })
  launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath()])
}

export function uninstall () {
  if (!supported()) return
  launchctl(['bootout', target()], { quiet: true })
  fs.rmSync(plistPath(), { force: true })
}

// { installed, running, pid }
export function status () {
  if (!installed()) return { installed: false, running: false, pid: null }
  const out = launchctl(['print', target()], { quiet: true }) ?? ''
  const pid = Number(/^\s*pid = (\d+)/m.exec(out)?.[1]) || null
  return { installed: true, running: /^\s*state = running/m.test(out), pid }
}

// Start the daemon now; with `restart`, stop the running one first.
export function kickstart ({ restart = false } = {}) {
  launchctl(['kickstart', ...(restart ? ['-k'] : []), target()])
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

function plist ({ args, path: dir }) {
  const log = path.join(config.home(), 'daemon.log')
  const env = {
    PATH: [dir, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
    HOME: os.homedir(),
    ...(process.env.PEARBELL_HOME ? { PEARBELL_HOME: process.env.PEARBELL_HOME } : {}),
    ...(process.env.VOLTA_HOME ? { VOLTA_HOME: process.env.VOLTA_HOME } : {})
  }
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
${Object.entries(env).map(([k, v]) => `    <key>${k}</key>\n    <string>${x(v)}</string>`).join('\n')}
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
