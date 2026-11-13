// A stand-in for an Agent Client Protocol agent (`opencode acp`, PRDCT-4427).
// It never calls a provider: it speaks ACP version 1 (newline-delimited
// JSON-RPC 2.0) on its stdio and answers every prompt by echoing it. The unit
// tests run it with `process.execPath`; the end-to-end specs install it as a
// `bin/opencode` that takes the `acp` subcommand.
//
// State lives under `ACP_STAND_IN_STATE` (created when missing):
//   frames.jsonl              every frame received, `{ t, frame }` per line
//   sessions/<id>.jsonl       each session's turns (`{ kind: 'user' | 'agent' | 'tool', … }`)
//   sessions/<id>.json        the session's cwd and model, for list and load
//
// Behaviour switches: `ACP_STAND_IN_REFUSE=auth` refuses every session/new
// (-32000 Not signed in); `ACP_STAND_IN_DELAY_MS` waits before each answer to
// a prompt; `ACP_STAND_IN_LIST_CURSOR=always` names a next cursor on every
// session/list page, as OpenCode 2.3.0 does; `ACP_STAND_IN_STRAY_UPDATE=1`
// sends, during each prompt, one `agent_message_chunk` for the session
// `ses_other` (another session's update). A prompt containing `slow` waits
// 20 s (cancellable); one containing `ask permission` asks the client first
// and echoes the option.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('stand-in 0.0.0\n')
  process.exit(0)
}
if (argv.some((arg) => arg !== 'acp')) {
  process.stderr.write('usage: acp-agent.mjs acp | --version\n')
  process.exit(2)
}

const stateDir = process.env.ACP_STAND_IN_STATE
if (!stateDir) {
  process.stderr.write('ACP_STAND_IN_STATE is required\n')
  process.exit(2)
}
const sessionsDir = path.join(stateDir, 'sessions')
mkdirSync(sessionsDir, { recursive: true })
const framesFile = path.join(stateDir, 'frames.jsonl')
const delayMs = Number(process.env.ACP_STAND_IN_DELAY_MS ?? 0) || 0
const refuse = process.env.ACP_STAND_IN_REFUSE

const MODELS = [
  { value: 'stand-in/one', name: 'One' },
  { value: 'stand-in/two', name: 'Two' },
  { value: 'stand-in/three', name: 'Three' }
]
const COMMANDS = [
  { name: 'init', description: 'Write an AGENTS.md for this folder' },
  { name: 'compact', description: 'Summarize the conversation' }
]

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const answer = (id, result) => send({ id, result })
const refuseFrame = (id, code, message) => send({ id, error: { code, message } })
const update = (sessionId, body) =>
  send({ method: 'session/update', params: { sessionId, update: body } })

const metaFile = (id) => path.join(sessionsDir, `${id}.json`)
const turnsFile = (id) => path.join(sessionsDir, `${id}.jsonl`)
const known = (id) =>
  typeof id === 'string' && /^ses_[0-9a-f]+$/.test(id) && existsSync(metaFile(id))
const readMeta = (id) => JSON.parse(readFileSync(metaFile(id), 'utf8'))
const writeMeta = (id, meta) => writeFileSync(metaFile(id), JSON.stringify(meta))
const record = (id, turn) => appendFileSync(turnsFile(id), `${JSON.stringify(turn)}\n`)
const configOptions = (model) => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: MODELS
  }
]

/** The running prompt of each session: its cancel, and the permission it waits on. */
const running = new Map()
let nextOwnId = 0
const ownRequests = new Map()
const askClient = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextOwnId
    ownRequests.set(id, resolve)
    send({ id, method, params })
  })

const sleep = (ms, turn) =>
  new Promise((resolve) => {
    if (ms <= 0 || turn.cancelled) return resolve()
    const timer = setTimeout(() => {
      turn.wake = undefined
      resolve()
    }, ms)
    turn.wake = () => {
      clearTimeout(timer)
      resolve()
    }
  })

const textOf = (prompt) =>
  (Array.isArray(prompt) ? prompt : [])
    .map((block) => (block && block.type === 'text' ? String(block.text) : ''))
    .join('')

async function prompt(id, params) {
  const sessionId = params?.sessionId
  if (!known(sessionId)) return refuseFrame(id, -32602, 'Unknown session')
  if (running.has(sessionId)) return refuseFrame(id, -32602, 'A prompt is already running')
  const text = textOf(params.prompt)
  const turn = { cancelled: false }
  running.set(sessionId, turn)
  record(sessionId, { kind: 'user', text })
  const finish = (stopReason) => {
    running.delete(sessionId)
    const meta = readMeta(sessionId)
    writeMeta(sessionId, { ...meta, updatedAt: new Date().toISOString() })
    answer(id, { stopReason })
  }
  await sleep(delayMs, turn)
  if (turn.cancelled) return finish('cancelled')
  if (text.includes('slow')) {
    await sleep(20_000, turn)
    if (turn.cancelled) return finish('cancelled')
  }
  let agentText = ''
  const say = (chunk) => {
    agentText += chunk
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: chunk }
    })
  }
  if (text.includes('ask permission')) {
    const toolCallId = `call_${randomBytes(4).toString('hex')}`
    const result = await askClient('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId,
        title: 'Write notes.md',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'notes.md' }
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
      ]
    })
    const outcome = result?.outcome
    say(`permission: ${outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'}`)
    if (turn.cancelled) return finish('cancelled')
  }
  say('You said: ')
  // Another session's text in the middle of this prompt, as a subagent's
  // child session streams beside its parent's.
  if (process.env.ACP_STAND_IN_STRAY_UPDATE === '1')
    update('ses_other', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'stray text of another session' }
    })
  const half = Math.ceil(text.length / 2)
  say(text.slice(0, half))
  say(text.slice(half))
  const toolCallId = `call_${randomBytes(4).toString('hex')}`
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: 'Read README.md',
    kind: 'read',
    status: 'in_progress',
    rawInput: { path: 'README.md' }
  })
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '# Stand-in' } }]
  })
  record(sessionId, { kind: 'agent', text: agentText })
  record(sessionId, {
    kind: 'tool',
    toolCallId,
    title: 'Read README.md',
    toolKind: 'read',
    rawInput: { path: 'README.md' },
    output: '# Stand-in'
  })
  finish(turn.cancelled ? 'cancelled' : 'end_turn')
}

function load(id, params) {
  const sessionId = params?.sessionId
  if (!known(sessionId)) return refuseFrame(id, -32602, 'Unknown session')
  const turns = existsSync(turnsFile(sessionId))
    ? readFileSync(turnsFile(sessionId), 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : []
  for (const turn of turns) {
    if (turn.kind === 'user')
      update(sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: turn.text }
      })
    else if (turn.kind === 'agent')
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: turn.text }
      })
    else if (turn.kind === 'tool') {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: turn.toolCallId,
        title: turn.title,
        kind: turn.toolKind,
        status: 'in_progress',
        rawInput: turn.rawInput
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: turn.toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: turn.output } }]
      })
    }
  }
  answer(id, { configOptions: configOptions(readMeta(sessionId).model) })
}

function list(id, params) {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : undefined
  const sessions = readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const sessionId = name.slice(0, -'.json'.length)
      const meta = readMeta(sessionId)
      return {
        sessionId,
        cwd: meta.cwd,
        updatedAt: meta.updatedAt ?? statSync(metaFile(sessionId)).mtime.toISOString()
      }
    })
    .filter((session) => !cwd || session.cwd === cwd)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  // OpenCode 2.3.0 names a `nextCursor` even on its only page; this mode copies it.
  if (process.env.ACP_STAND_IN_LIST_CURSOR === 'always')
    return answer(id, { sessions, nextCursor: 'more' })
  answer(id, { sessions })
}

function handle(frame) {
  const { id, method, params } = frame
  const isRequest = typeof id === 'string' || typeof id === 'number'
  if (typeof method !== 'string') {
    // An answer to one of our own requests.
    const resolve = isRequest ? ownRequests.get(id) : undefined
    if (resolve) {
      ownRequests.delete(id)
      resolve(frame.result)
    }
    return
  }
  if (!isRequest) {
    if (method === 'session/cancel') {
      const turn = running.get(params?.sessionId)
      if (turn) {
        turn.cancelled = true
        turn.wake?.()
      }
    }
    return
  }
  switch (method) {
    case 'initialize':
      return answer(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} }
        },
        authMethods: [
          {
            id: 'stand-in-login',
            name: 'Sign in',
            description: 'Run `stand-in login` in the terminal'
          }
        ],
        agentInfo: { name: 'Stand-in', version: '0.0.0' }
      })
    case 'session/new': {
      if (refuse === 'auth') return refuseFrame(id, -32000, 'Not signed in')
      const sessionId = `ses_${randomBytes(8).toString('hex')}`
      const model = MODELS[0].value
      writeMeta(sessionId, {
        cwd: typeof params?.cwd === 'string' ? params.cwd : '',
        model,
        updatedAt: new Date().toISOString()
      })
      writeFileSync(turnsFile(sessionId), '')
      answer(id, { sessionId, configOptions: configOptions(model) })
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS })
      return
    }
    case 'session/load':
      return load(id, params)
    case 'session/prompt':
      void prompt(id, params)
      return
    case 'session/set_config_option': {
      const sessionId = params?.sessionId
      if (!known(sessionId)) return refuseFrame(id, -32602, 'Unknown session')
      if (params.configId !== 'model' || !MODELS.some((m) => m.value === params.value))
        return refuseFrame(id, -32602, 'Unknown config value')
      writeMeta(sessionId, { ...readMeta(sessionId), model: params.value })
      return answer(id, { configOptions: configOptions(params.value) })
    }
    case 'session/list':
      return list(id, params)
    default:
      return refuseFrame(id, -32601, `Method not found: ${method}`)
  }
}

let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  let end
  while ((end = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, end).trim()
    pending = pending.slice(end + 1)
    if (!line) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      continue
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue
    appendFileSync(framesFile, `${JSON.stringify({ t: Date.now(), frame })}\n`)
    handle(frame)
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
