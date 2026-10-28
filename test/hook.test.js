import test from 'brittle'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { onJSON, writeJSON } from '../shared/lines.js'
import { hookOutput, inboxPrompt } from '../cli/hook.js'

const BIN = new URL('../cli/bin.js', import.meta.url).pathname

// `pearbell inbox --hook` against a stand-in daemon that has these messages.
async function runHook (t, input, messages) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pearbell-hook-'))
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }))

  const requests = []
  if (messages) {
    const server = net.createServer((sock) => {
      onJSON(sock, (req) => {
        requests.push(req)
        writeJSON(sock, { type: 'inbox', messages })
        sock.end()
      })
    })
    await new Promise((resolve) => server.listen(path.join(home, 'daemon.sock'), resolve))
    t.teardown(() => server.close())
  }

  const child = spawn(process.execPath, [BIN, 'inbox', '--hook'], { env: { ...process.env, PEARBELL_HOME: home, CLAUDE_PROJECT_DIR: '' } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stdin.end(JSON.stringify(input))
  const code = await new Promise((resolve) => child.once('exit', resolve))
  return { code, out, requests }
}

const said = [{ id: 's1', topic: 'demo', text: 'How is it going?', device: 'Pixel 8', at: 1 }]

test('hook: PostToolUse gets the messages as context', async (t) => {
  const { code, out, requests } = await runHook(t, { hook_event_name: 'PostToolUse', cwd: '/x/demo' }, said)
  t.is(code, 0)
  t.alike(requests, [{ type: 'inbox', topic: 'demo' }], 'topic from the session folder')
  const json = JSON.parse(out)
  t.is(json.hookSpecificOutput.hookEventName, 'PostToolUse')
  t.ok(json.hookSpecificOutput.additionalContext.includes('> How is it going?'))
})

test('hook: Stop keeps Claude going to answer', async (t) => {
  const { out } = await runHook(t, { hook_event_name: 'Stop', cwd: '/x/demo' }, said)
  const json = JSON.parse(out)
  t.is(json.decision, 'block')
  t.ok(json.reason.includes('topic "demo"'))
})

test('hook: nothing waiting, or no daemon, prints nothing', async (t) => {
  const empty = await runHook(t, { hook_event_name: 'Stop', cwd: '/x/demo' }, [])
  t.is(empty.code, 0)
  t.is(empty.out, '')

  const none = await runHook(t, { hook_event_name: 'PostToolUse', cwd: '/x/demo' }, null)
  t.is(none.code, 0)
  t.is(none.out, '')
})

test('hook: the prompt quotes every message and says how to answer', (t) => {
  const text = inboxPrompt('demo', [{ text: 'one\ntwo', device: 'Pixel' }, { text: 'three', device: 'Pixel' }])
  t.ok(text.includes('> one\n> two\n(from Pixel)'))
  t.ok(text.includes('> three'))
  t.ok(text.includes('pearbell send -T "demo"'))
  t.alike(hookOutput('UserPromptSubmit', 'x'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' } })
  t.alike(hookOutput('SubagentStop', 'x'), { decision: 'block', reason: 'x' })
})
