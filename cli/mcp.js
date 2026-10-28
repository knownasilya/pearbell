// `pearbell mcp`: a Model Context Protocol server on stdin/stdout, so AI tools
// like Claude Code get typed tools instead of shell commands. Each tool call
// goes to the daemon over the local socket (control.js), starting it if
// needed, exactly as the CLI commands do.
//
//   send     { body, title?, topic?, id?, device?, to? }
//   update   { id, body, title?, topic?, device?, to? }
//   ask      { body, actions?, title?, topic?, id?, device?, to?, timeout? }
//   devices  {}
//
// Newline-delimited JSON-RPC 2.0. stdout carries protocol frames only.
// The HTTP API (http.js) serves the same tools at POST /mcp, for MCP clients
// that only speak Streamable HTTP.
import fs from 'node:fs'
import { onJSON, writeJSON } from '../shared/lines.js'
import { MAX_BODY } from '../shared/protocol.js'
import * as control from './control.js'
import { presenceText } from './router.js'

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const INSTRUCTIONS = `pearbell sends messages to the user's phone (and their Mac, if the menu bar app runs) and brings their answers back.
Use send to tell them something (a job finished, something broke). Use ask when you need a decision and they may be away from the computer: it waits for their answer.
Message text is Markdown, including tables, fenced code blocks and https images. For progress, send a task list ("- [ ] step" lines) with an id, then call update with the same id and "- [x]" for done steps; that edits the message in place without a new notification.`

const target = {
  title: { type: 'string', description: 'Notification title, such as the tool or project name' },
  topic: { type: 'string', description: 'Groups messages in the app (up to 40 characters)' },
  device: { type: 'string', description: 'Only this phone (name or start of its key). Default: every paired phone' },
  to: { type: 'string', enum: control.ROUTES, description: 'auto (default) shows it on the Mac while the user is at it, else on the phone' }
}

const TOOLS = [
  {
    name: 'send',
    description: 'Send a notification to the user\'s phone. Returns once it is delivered (or queued, if the phone is offline: it gets it when it reconnects). Give it an id to change it later with update.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: `The message, in Markdown (up to ${MAX_BODY} characters). "- [ ] task" and "- [x] task" lines show as a checklist` },
        id: { type: 'string', description: 'Your own id for the message (up to 64 characters, no spaces), so update can change it' },
        ...target
      },
      required: ['body']
    }
  },
  {
    name: 'update',
    description: 'Change a message sent earlier with an id: new text, and a new title or topic if given. No new notification sound. Handy for ticking off a task list as work progresses.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id the message was sent with' },
        body: { type: 'string', description: 'The new text, in Markdown. It replaces the old text' },
        ...target
      },
      required: ['id', 'body']
    }
  },
  {
    name: 'ask',
    description: 'Ask the user a question on their phone and wait for the answer, which comes back as text. They can tap one of the actions or type a reply. Times out after timeout seconds (default 600).',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The question, in Markdown' },
        actions: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Up to 3 quick-reply buttons, such as ["Yes", "No"]. The user can always type a reply instead' },
        timeout: { type: 'number', minimum: 0, description: 'Seconds to wait for the answer (default 600, 0 waits forever)' },
        id: { type: 'string', description: 'Your own id for the question, so update can change its text while it is open' },
        ...target
      },
      required: ['body']
    }
  },
  {
    name: 'devices',
    description: 'List the paired phones, whether each is online, and whether the Mac menu bar app is running.',
    inputSchema: { type: 'object', properties: {} }
  }
]

export function serveMcp ({ input = process.stdin, output = process.stdout } = {}) {
  const calls = new Map() // request id -> AbortController, for cancellation
  const write = (frame) => writeJSON(output, { jsonrpc: '2.0', ...frame })

  onJSON(input, async (req) => {
    const res = await answer(req, { calls, write })
    if (res) write(res)
  })

  // Resolves when the client hangs up. Open questions close with the process.
  return new Promise((resolve) => {
    input.once('end', () => {
      for (const abort of calls.values()) abort.abort()
      resolve()
    })
  })
}

// Answer one JSON-RPC message: the response frame, or null for a notification.
// calls maps request ids to AbortControllers, so a cancel can stop a call.
// write sends progress notifications (stdio only). start: false never starts
// the daemon (the HTTP API runs inside it).
export async function answer (req, { calls = new Map(), write, start = true, signal } = {}) {
  if (req?.method === 'notifications/cancelled') {
    calls.get(req.params?.requestId)?.abort()
    return null
  }
  if (req?.id === undefined || req.id === null) return null // other notifications

  try {
    return { jsonrpc: '2.0', id: req.id, result: await handle(req) }
  } catch (err) {
    return { jsonrpc: '2.0', id: req.id, error: { code: err.rpcCode || -32603, message: err.message } }
  }

  async function handle (req) {
    switch (req.method) {
      case 'initialize': {
        const asked = req.params?.protocolVersion
        return {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'pearbell', version },
          instructions: INSTRUCTIONS
        }
      }
      case 'ping': return {}
      case 'tools/list': return { tools: TOOLS }
      case 'tools/call': {
        const abort = new AbortController()
        calls.set(req.id, abort)
        signal?.addEventListener('abort', () => abort.abort())
        const progress = req.params?._meta?.progressToken
        let step = 0
        const notify = progress === undefined || !write
          ? () => {}
          : (message) => write({ method: 'notifications/progress', params: { progressToken: progress, progress: ++step, message } })
        try {
          return await callTool(req.params?.name, req.params?.arguments || {}, { signal: abort.signal, notify, start })
        } catch (err) {
          // Tool failures go back to the model as results it can read.
          return { content: [{ type: 'text', text: err.message }], isError: true }
        } finally {
          calls.delete(req.id)
        }
      }
      default:
        throw Object.assign(new Error(`Unknown method ${req.method}`), { rpcCode: -32601 })
    }
  }
}

export async function callTool (name, args, { signal, notify = () => {}, start = true } = {}) {
  if (name === 'devices') return devices(start)
  if (!['send', 'update', 'ask'].includes(name)) throw new Error(`Unknown tool ${name}`)

  const update = name === 'update'
  const wantsReply = name === 'ask'
  const body = typeof args.body === 'string' ? args.body.trim() : ''
  if (!body) throw new Error('body is required')

  const key = args.id === undefined || args.id === '' ? undefined : String(args.id)
  const bad = control.badKey(key, update)
  if (bad) throw new Error(bad)
  if (args.to !== undefined && !control.ROUTES.includes(args.to)) throw new Error(`to must be one of ${control.ROUTES.join(', ')}`)

  const actions = wantsReply && Array.isArray(args.actions) ? args.actions.map(String).filter(Boolean) : []
  const seconds = wantsReply
    ? (Number.isFinite(args.timeout) && args.timeout >= 0 ? args.timeout : 600)
    : 10
  const message = { title: str(args.title), topic: str(args.topic), body, actions, wantsReply, key, update }

  const onframe = (frame) => {
    if (frame.type === 'delivered') notify(`delivered to ${frame.device}`)
    else if (frame.type === 'routed') notify(`sent to the phone too: ${frame.reason}`)
  }
  const result = await control.send({ message, device: args.device, route: args.to, seconds, signal, onframe, start })
  const { queued, reply, error } = result

  if (error) throw new Error(error.error)
  if (!queued) throw new Error('The daemon closed the connection')

  const out = {
    id: queued.id,
    ...(key ? { key } : {}),
    ...(body.length > MAX_BODY ? { truncated: true } : {})
  }
  if (wantsReply) {
    if (!reply) throw new Error(result.timedOut ? `No reply within ${seconds}s` : signal?.aborted ? 'Cancelled' : 'The daemon stopped')
    return json({ ...out, reply: reply.text, device: reply.device })
  }
  return json({ ...out, route: queued.route, delivered: result.delivered, queued: result.missing })
}

async function devices (start) {
  const sock = await control.connect({ start })
  let status = null
  await control.request(sock, { type: 'status' }, (frame) => { status = frame })
  if (!status) throw new Error('The daemon closed the connection')
  return json({
    phones: status.devices.map((d) => ({ name: d.name, connected: d.connected })),
    // The menu bar app: null when it is not running, else how the user is at the Mac.
    mac: status.mac ? presenceText(status.mac.presence) : null
  })
}

function json (value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

function str (value) {
  return typeof value === 'string' ? value : ''
}
