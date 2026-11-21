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
// 20 s (cancellable); one containing `long turn` streams its echo in three
// pieces a second apart, or `ACP_STAND_IN_LONG_TURN_MS` apart (cancellable);
// one containing `rate limited` says two retries first,
// as OpenCode does under a provider's 429; one containing `ask permission`
// asks the client first and echoes the option. `OPENCODE_CONFIG_CONTENT`,
// when set, chooses the models as OpenCode's own (below).
// `ACP_STAND_IN_MODES=1` adds a `mode` config option with Antigravity's ladder
// (`agy acp` 1.5: default, accept-edits, auto, plan), set by
// session/set_config_option as the model is.
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
import {
  callClaveTool,
  callClaveTools,
  claveCallOf,
  opencodeSubstitute
} from './clave-tools-call.mjs'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('stand-in 0.0.0\n')
  process.exit(0)
}

const stateDir = process.env.ACP_STAND_IN_STATE
if (!stateDir) {
  process.stderr.write('ACP_STAND_IN_STATE is required\n')
  process.exit(2)
}
const sessionsDir = path.join(stateDir, 'sessions')
mkdirSync(sessionsDir, { recursive: true })

// PRDCT-4551: OpenCode's two documented reads of what a session used, as
// OpenCode 2.3.0 answers them (read off the real program on 14 November
// 2026): `api --standalone GET /api/session?…` lists every session with its
// `time.updated`; `session export --standalone <id>` gives its messages, an
// assistant message carrying `model.providerID`, `tokens` and `cost`. Each
// prompt below records the usage a real call would have.
/** The script the stand-in model runs in code mode (`run code`, PRDCT-4507),
 *  the one sent to the real 2.3.0. */
const SCRIPT =
  'const found = await search({ query: "list tabs" }); const r = await tools.clave.clave_list({}); return r'

const readTurns = (id) => {
  const file = path.join(sessionsDir, `${id}.jsonl`)
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : []
}
if (argv[0] === 'api' && argv.includes('GET') && argv.some((a) => a.startsWith('/api/session'))) {
  const data = readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const id = name.slice(0, -'.json'.length)
      const meta = JSON.parse(readFileSync(path.join(sessionsDir, name), 'utf8'))
      const updated =
        Date.parse(meta.updatedAt ?? '') || statSync(path.join(sessionsDir, name)).mtimeMs
      return { id, time: { created: updated, updated }, location: { directory: meta.cwd ?? '' } }
    })
    .sort((a, b) => b.time.updated - a.time.updated)
  process.stdout.write(`${JSON.stringify({ data, cursor: {} })}\n`)
  process.exit(0)
}
if (argv[0] === 'session' && argv[1] === 'export') {
  const id = argv.filter((a) => !a.startsWith('--'))[2]
  if (!id || !existsSync(path.join(sessionsDir, `${id}.json`))) {
    process.stderr.write(`Session not found: ${id}\n`)
    process.exit(1)
  }
  const messages = readTurns(id)
    .filter((turn) => turn.kind === 'usage')
    .map((turn, i) => ({
      id: `msg_${i}`,
      time: { created: turn.at - 5, completed: turn.at },
      type: 'assistant',
      agent: 'build',
      model: { id: turn.modelID, providerID: turn.providerID },
      content: [],
      finish: 'stop',
      cost: turn.cost,
      tokens: turn.tokens
    }))
  process.stdout.write(`${JSON.stringify({ info: { id }, messages })}\n`)
  process.exit(0)
}
if (argv.some((arg) => arg !== 'acp')) {
  process.stderr.write('usage: acp-agent.mjs acp | api … | session export … | --version\n')
  process.exit(2)
}
const framesFile = path.join(stateDir, 'frames.jsonl')
const delayMs = Number(process.env.ACP_STAND_IN_DELAY_MS ?? 0) || 0
const longTurnMs = Number(process.env.ACP_STAND_IN_LONG_TURN_MS ?? 1000) || 1000
const refuse = process.env.ACP_STAND_IN_REFUSE

// Named the way OpenCode 2.3.0 names them: `provider/Name`.
const OWN_MODELS = [
  { value: 'stand-in/one', name: 'stand-in/One' },
  { value: 'stand-in/two', name: 'stand-in/Two' },
  { value: 'stand-in/three', name: 'stand-in/Three' }
]
// The configuration in the environment (`OPENCODE_CONFIG_CONTENT`), read the
// way the real `opencode acp` 2.3.0 reads it (checked by hand, a made-up key):
// a new session opens on its `model`, and `enabled_providers` leaves only
// those providers' models on offer.
const envConfig = (() => {
  try {
    return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '')
  } catch {
    return null
  }
})()
const configured = typeof envConfig?.model === 'string' ? envConfig.model : null
// A model the provider does not have (`…/no-such-model…`): the real agent
// opens its session on a model of its own choosing, silently (checked by
// hand on 2.3.0: `kimi-code-plan-global/no-such-model-zz` opened on
// `kimi-code-plan-global/k3.1-pro`, the asked one not listed). Here, that
// provider's `stand-in-default`.
const unknownConfigured = configured !== null && /\/no-such-model/.test(configured)
const configModel = unknownConfigured ? `${configured.split('/')[0]}/stand-in-default` : configured
const enabledProviders = Array.isArray(envConfig?.enabled_providers)
  ? envConfig.enabled_providers
  : null
const MODELS = [
  ...(configModel && !OWN_MODELS.some((m) => m.value === configModel)
    ? [{ value: configModel, name: configModel }]
    : []),
  ...OWN_MODELS
].filter((m) => !enabledProviders || enabledProviders.includes(m.value.split('/')[0]))
const COMMANDS = [
  { name: 'init', description: 'Write an AGENTS.md for this folder' },
  { name: 'compact', description: 'Summarize the conversation' }
]

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const answer = (id, result) => send({ id, result })
const refuseFrame = (id, code, message) => send({ id, error: { code, message } })
const update = (sessionId, body) =>
  send({ method: 'session/update', params: { sessionId, update: body } })

// Clave's own tools (PRDCT-4507), once per process, as OpenCode 2.3.0 connects
// its servers: `mcp.servers.clave` of the inline configuration, its
// `{env:NAME}` references resolved from the environment, else a `clave` HTTP
// server handed in `mcpServers` over the protocol. Only with
// `CLAVE_TOOLS_STAND_IN_LOG` set (clave-tools-call.mjs).
let claveToolsCalled = false
/** The server found at the session's start: a prompt `clave-open {…}` calls
 *  `clave_open_session` on it as the model would (PRDCT-4507). */
let claveServer = null
function opencodeClaveTools(params) {
  if (claveToolsCalled || !process.env.CLAVE_TOOLS_STAND_IN_LOG) return
  claveToolsCalled = true
  const inline = envConfig?.mcp?.servers?.clave
  const handed = (Array.isArray(params?.mcpServers) ? params.mcpServers : []).find(
    (server) => server?.name === 'clave'
  )
  let server = null
  if (inline?.type === 'remote' && typeof inline.url === 'string')
    server = {
      url: inline.url,
      headers: Object.fromEntries(
        Object.entries(inline.headers ?? {}).map(([name, value]) => [
          name,
          opencodeSubstitute(value)
        ])
      )
    }
  else if (handed?.url)
    server = {
      url: handed.url,
      headers: Object.fromEntries((handed.headers ?? []).map((h) => [h.name, h.value]))
    }
  claveServer = server
  void callClaveTools(server, {
    harness: 'opencode',
    form: 'acp',
    source: inline ? 'inline' : handed ? 'protocol' : null,
    codemode: inline?.codemode ?? null,
    // OpenCode 2.3.0 declares a server's tools only with code mode off.
    declare: inline?.codemode === false ? 'all' : [],
    configHoldsToken: (process.env.OPENCODE_CONFIG_CONTENT ?? '').includes(
      process.env.CLAVE_TAB_MCP_TOKEN || '\u0000'
    )
  })
}

const metaFile = (id) => path.join(sessionsDir, `${id}.json`)
const turnsFile = (id) => path.join(sessionsDir, `${id}.jsonl`)
const known = (id) =>
  typeof id === 'string' && /^ses_[0-9a-f]+$/.test(id) && existsSync(metaFile(id))
const readMeta = (id) => JSON.parse(readFileSync(metaFile(id), 'utf8'))
const writeMeta = (id, meta) => writeFileSync(metaFile(id), JSON.stringify(meta))
const record = (id, turn) => appendFileSync(turnsFile(id), `${JSON.stringify(turn)}\n`)
const MODES = process.env.ACP_STAND_IN_MODES === '1'
const MODE_VALUES = ['default', 'accept-edits', 'auto', 'plan']
const configOptions = (model, mode = 'default') => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: MODELS
  },
  ...(MODES
    ? [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: mode,
          options: MODE_VALUES.map((value) => ({ value, name: value }))
        }
      ]
    : [])
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
  // A provider refusing with 429 twice before it answers: OpenCode 2.3.0
  // says each retry as a `session_info_update` whose `_meta["opencode/retry"]`
  // carries the attempt and the error, and null once the retry went out (the
  // frames copied from the real agent against a stand-in provider).
  if (text.includes('rate limited')) {
    for (const attempt of [2, 3]) {
      update(sessionId, {
        sessionUpdate: 'session_info_update',
        _meta: {
          'opencode/retry': {
            attempt,
            nextRetryAt: new Date(Date.now() + 3000).toISOString(),
            error: {
              type: 'provider.rate-limit',
              message: 'stand-in: rate limited',
              status: 429,
              retryAfterMs: 3000
            }
          }
        }
      })
      await sleep(1500, turn)
      if (turn.cancelled) return finish('cancelled')
      update(sessionId, { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } })
    }
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
  // `clave-open {…}` / `clave-call <tool> {…}`: the model calls that tool
  // once with those arguments (PRDCT-4507), and says what came back.
  const call = claveCallOf(text)
  if (call) {
    const answer = call.args
      ? await callClaveTool(claveServer, call.name, call.args)
      : { ok: false, error: 'bad arguments' }
    say(`${call.name}: ${JSON.stringify(answer)}`)
    record(sessionId, { kind: 'agent', text: agentText })
    return finish(turn.cancelled ? 'cancelled' : 'end_turn')
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
  // `long turn`: the answer streams in three pieces a second apart (or
  // `ACP_STAND_IN_LONG_TURN_MS`), as a model's long answer does while the
  // person writes more (PRDCT-4566).
  const pause = text.includes('long turn') ? longTurnMs : 0
  if (pause) {
    await sleep(pause, turn)
    if (turn.cancelled) return finish('cancelled')
  }
  say(text.slice(0, half))
  if (pause) {
    await sleep(pause, turn)
    if (turn.cancelled) return finish('cancelled')
  }
  say(text.slice(half))
  // `run code`: OpenCode 2.3.0's code mode, frame for frame as the real
  // `opencode acp` sent them on 14 November 2026 (PRDCT-4507): the `execute`
  // call opens with `rawInput: {}`, its script arrives with the `in_progress`
  // update (twice), and the completion names the tools the script called.
  if (text.includes('run code')) {
    const scriptId = `call_${randomBytes(4).toString('hex')}`
    const code = SCRIPT
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: scriptId,
      name: 'execute',
      title: 'execute',
      kind: 'other',
      status: 'pending',
      locations: [],
      rawInput: {}
    })
    for (let i = 0; i < 2; i++)
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: scriptId,
        status: 'in_progress',
        kind: 'other',
        title: 'execute',
        locations: [],
        rawInput: { code }
      })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: scriptId,
      status: 'completed',
      locations: [],
      content: [{ type: 'content', content: { type: 'text', text: 'stand-in answer' } }],
      rawOutput: {
        metadata: {
          toolCalls: [
            { tool: 'search', status: 'completed', input: { query: 'list tabs' } },
            { tool: 'clave.clave_list', status: 'completed' }
          ],
          truncated: false
        }
      }
    })
    record(sessionId, { kind: 'agent', text: agentText })
    record(sessionId, { kind: 'script', toolCallId: scriptId, code, output: 'stand-in answer' })
    return finish(turn.cancelled ? 'cancelled' : 'end_turn')
  }
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
  // What the model call used, as OpenCode keeps it per message (PRDCT-4551):
  // under the provider its model is named by, never replayed on a load.
  const [providerID, ...modelParts] = String(readMeta(sessionId).model ?? 'stand-in/one').split('/')
  record(sessionId, {
    kind: 'usage',
    at: Date.now(),
    providerID,
    modelID: modelParts.join('/'),
    tokens: {
      input: 100 + text.length,
      output: agentText.length,
      reasoning: 0,
      cache: { read: 20, write: 0 }
    },
    cost: 0.001
  })
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
    else if (turn.kind === 'script') {
      // Replayed as it was sent: the script after the call (PRDCT-4507).
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: turn.toolCallId,
        title: 'execute',
        kind: 'other',
        status: 'pending',
        rawInput: {}
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: turn.toolCallId,
        status: 'in_progress',
        title: 'execute',
        rawInput: { code: turn.code }
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: turn.toolCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: turn.output } }]
      })
    } else if (turn.kind === 'tool') {
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
  const meta = readMeta(sessionId)
  answer(id, { configOptions: configOptions(meta.model, meta.mode) })
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
      opencodeClaveTools(params)
      const sessionId = `ses_${randomBytes(8).toString('hex')}`
      const model = configModel ?? MODELS[0]?.value
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
      opencodeClaveTools(params)
      return load(id, params)
    case 'session/prompt':
      void prompt(id, params)
      return
    case 'session/set_config_option': {
      const sessionId = params?.sessionId
      if (!known(sessionId)) return refuseFrame(id, -32602, 'Unknown session')
      const meta = readMeta(sessionId)
      if (MODES && params.configId === 'mode' && MODE_VALUES.includes(params.value)) {
        writeMeta(sessionId, { ...meta, mode: params.value })
        return answer(id, { configOptions: configOptions(meta.model, params.value) })
      }
      if (params.configId !== 'model' || !MODELS.some((m) => m.value === params.value))
        return refuseFrame(id, -32602, 'Unknown config value')
      writeMeta(sessionId, { ...meta, model: params.value })
      return answer(id, { configOptions: configOptions(params.value, meta.mode) })
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
