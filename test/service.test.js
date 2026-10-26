import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as service from '../cli/service.js'

test('service: the systemd unit runs the daemon and keeps it up', (t) => {
  const text = service.unit({ args: ['/usr/bin/node', '/opt/pearbell/cli/bin.js', 'daemon'], path: '/usr/bin' })
  t.ok(text.includes('ExecStart="/usr/bin/node" "/opt/pearbell/cli/bin.js" "daemon"'))
  t.ok(text.includes('Restart=always'))
  t.ok(text.includes('WantedBy=default.target'))
  t.ok(/^Environment="PEARBELL_HOME=.+"$/m.test(text))
})

test('service: odd characters survive the unit file', (t) => {
  const prev = process.env.PEARBELL_HOME
  t.teardown(() => { if (prev === undefined) delete process.env.PEARBELL_HOME; else process.env.PEARBELL_HOME = prev })

  const home = '/tmp/a "quoted" 100% $HOME \\ dir'
  process.env.PEARBELL_HOME = home
  const text = service.unit({ args: ['/bin/pear$bell', 'daemon'], path: '/bin' })
  t.is(service.unitHome(text), home)
  t.ok(text.includes('ExecStart="/bin/pear$$bell" "daemon"'), '$ is doubled in ExecStart')
  t.ok(text.includes('StandardOutput=journal'), 'a log path with spaces goes to the journal')
})

test('service: installed only for the same pearbell home', { skip: process.platform !== 'linux' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearbell-service-'))
  const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PEARBELL_HOME: process.env.PEARBELL_HOME }
  t.teardown(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  process.env.XDG_CONFIG_HOME = dir
  process.env.PEARBELL_HOME = path.join(dir, 'pearbell')
  t.is(service.file(), path.join(dir, 'systemd', 'user', 'pearbell.service'))
  t.absent(service.installed())

  fs.mkdirSync(path.dirname(service.file()), { recursive: true })
  fs.writeFileSync(service.file(), service.unit({ args: ['pearbell', 'daemon'], path: '/usr/bin' }))
  t.ok(service.installed())

  process.env.PEARBELL_HOME = path.join(dir, 'other')
  t.absent(service.installed(), 'a second identity gets its own daemon')
})
