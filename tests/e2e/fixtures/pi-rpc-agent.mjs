// A stand-in for Pi's rpc mode (`pi --mode rpc`, Pi 1.5.2, PRDCT-4427). It
// never calls a provider: it speaks Pi's rpc protocol (strict JSONL on its
// stdio, commands answered by `response` frames of the same id, events with
// no id in between) and answers every prompt by echoing it, the prompt's
// answer and its run's `agent_start` in writes of their own, as Pi 1.5.2
// sends them (a client reads them apart, PRDCT-4566). The unit tests
// run it with `process.execPath`; the end-to-end specs install it as a
// `bin/pi`.
//
// State lives in `--session-dir` when given, else `PI_STAND_IN_STATE`:
//   frames.jsonl                  every frame received, `{ t, frame }` per line
//   <timestamp>_<id>.jsonl        each session in Pi's own file format (v3),
//                                 written at its first message, as Pi does
//
// Like Pi 1.5.2, `--provider` without `--model` is refused on stderr with exit
// code 1 before any frame.
//
// Behaviour switches: `PI_STAND_IN_DELAY_MS` waits between the events of a
// run; `PI_STAND_IN_ANY_PROVIDER=1` takes `--provider p --model m` for any
// provider but its own, as Pi takes one its models.json declares;
// `PI_STAND_IN_ENV_PROVIDERS=1` lists Anthropic's model too while
// `ANTHROPIC_API_KEY` is in the environment, as Pi lists every provider it
// finds a key for (a prompt containing `use anthropic` then moves the model
// there, as a command typed in the chat could); `PI_STAND_IN_NO_MODEL=1` leaves the model out of `get_state` and fails
// every prompt with `No model selected`; `PI_STAND_IN_STREAMING_ONCE=1` refuses
// the first prompt with `Agent is streaming` and runs nothing;
// `PI_STAND_IN_IDLE_STEER=queue` answers a `steer` sent while idle `queued`
// and starts nothing, holding it for the next run to take, as Pi 1.5.2 does
// (else it starts a run); `PI_STAND_IN_CLEAR_AFTER_STEP=1` answers a
// `clear_queue` sent while steers wait only once the next one has started,
// as Pi does when the clear races its step; `PI_STAND_IN_ABORT_KEEPS_QUEUE=1`
// keeps the queues across an abort, as Pi 1.5.2 does (its abort clears none):
// a steer queued while the run stops stays held for a next run, which nothing
// starts; `PI_STAND_IN_DRAIN_GAP_MS` waits that long between taking a steer off
// the queue at a step and starting its user message, and a `clear_queue` in
// between still lists it, though the run goes on to start it, as Pi 1.5.2 does
// (its loop drains the queue at the step's end, and the list `clear_queue`
// reads loses the message only at its user message_start). A prompt
// containing `slow` waits 20 s
// before its first text delta (an abort cuts it short); `long turn` streams its
// echo in three pieces a second apart, or `PI_STAND_IN_LONG_TURN_MS` apart (an
// abort cuts it short); `ask extension` asks a
// confirm dialog first and echoes the answer; `notify extension` sends a
// notify; `fail provider` ends its message with a provider error; `retry`
// starts with an auto-retry. An abort drops the steering and follow-up queue,
// unless told to keep them.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { callClaveTool, callClaveTools, claveCallOf } from './clave-tools-call.mjs'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  process.stdout.write('1.5.2-stand-in\n')
  process.exit(0)
}
const VALUED = new Set([
  '--mode',
  '--session-dir',
  '--session-id',
  '--session',
  '--model',
  '--provider',
  '--thinking',
  '--extension'
])
const flags = {}
let noSession = false
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (VALUED.has(arg)) flags[arg] = argv[++i]
  else if (arg === '--no-session') noSession = true
  // Any other flag is ignored.
}
// Clave's own tools (PRDCT-4507): the extension on the command line is loaded
// as Pi loads it, against a stand-in `pi` that takes its registration, and the
// server it registered is called with what it carries. Only with
// `CLAVE_TOOLS_STAND_IN_LOG` set (clave-tools-call.mjs).
/** The server the extension registered: a prompt `clave-open {…}` calls
 *  `clave_open_session` on it as the model would (PRDCT-4507). */
let resolveClaveServer = () => undefined
const claveServerReady = new Promise((resolve) => (resolveClaveServer = resolve))
async function piClaveTools(form) {
  if (!process.env.CLAVE_TOOLS_STAND_IN_LOG) return resolveClaveServer(null)
  const extension = flags['--extension']
  let server = null
  try {
    if (extension && process.env.CLAVE_MCP_CONFIG_FILE) {
      const started = []
      const pi = {
        on: (event, handler) => {
          if (event === 'session_start') started.push(handler)
        },
        getCommands: () => [{ name: 'mcp' }],
        registerMcpServer: (name, config) => {
          if (name === 'clave') server = config
        }
      }
      const mod = await import(pathToFileURL(extension).href)
      mod.default(pi)
      for (const handler of started) await handler({ reason: 'startup' }, {})
    }
  } catch {
    server = null
  }
  resolveClaveServer(server)
  await callClaveTools(server, {
    harness: 'pi',
    form,
    extension: !!extension,
    exposure: server?.exposure ?? null,
    // Pi declares the `direct` tools; a `deferred` server's others wait for
    // `tool_search`.
    declare:
      server?.exposure === 'direct'
        ? 'all'
        : Object.entries(server?.toolExposure ?? {})
            .filter(([, exposure]) => exposure === 'direct')
            .map(([name]) => name)
  })
}
// PRDCT-4540: a provider request as Pi makes one, through Clave's extension on
// the command line: its `before_provider_headers` handlers are given what
// Pi 1.5.2 gives them (`ctx.mode`, `ctx.model`, `ctx.modelRegistry.
// getProviderAuth`, `ctx.abort`). The credential resolved is the variable
// the tab names, or `PI_STAND_IN_LOGIN_KEY` (a `/login` in the tab).
let watchHandlers = null
async function connectionHandlers() {
  if (watchHandlers) return watchHandlers
  watchHandlers = []
  const extension = flags['--extension']
  if (!extension || !process.env.CLAVE_CONNECTION_REPORT_FILE) return watchHandlers
  try {
    const mod = await import(pathToFileURL(extension).href)
    mod.default({
      on: (event, handler) => {
        if (event === 'before_provider_headers') watchHandlers.push(handler)
      },
      getCommands: () => [],
      registerMcpServer: () => {}
    })
  } catch {
    // No extension: no watch.
  }
  return watchHandlers
}
async function providerRequest(mode, provider, abort, how, api = 'stand-in') {
  const keyVar = process.env.CLAVE_CONNECTION_KEY_VAR
  const ctx = {
    mode,
    // `api` is `pi-virtual` for a virtual model, as Pi 1.5.2 shows one.
    model: { provider, id: 'stand-in', api },
    modelRegistry: {
      // The provider ids extensions registered: Pi's own bundled one only.
      getRegisteredProviderIds: () => ['llama.cpp'],
      getProviderAuth: async () => {
        // `unchecked`: the credential cannot be resolved (the call throws).
        if (how === 'unchecked') throw new Error('stand-in: no credential resolution')
        return {
          auth: {
            apiKey:
              how === 'credential'
                ? 'e2e-made-up-login-key'
                : process.env.PI_STAND_IN_LOGIN_KEY || (keyVar ? process.env[keyVar] : undefined)
          },
          source: 'stand-in'
        }
      }
    },
    abort
  }
  for (const handler of await connectionHandlers())
    await handler({ type: 'before_provider_headers', headers: {} }, ctx)
}

// The terminal form (`PI_STAND_IN_TERMINAL=1`, no `--mode`): Clave's tools
// called once, a line printed, then it waits as a TUI would. With
// `PI_STAND_IN_TERMINAL_CONTROL`, each new line written in that file is one
// request: `<provider>` on that provider (the person's `/model` and a
// prompt), `<provider> credential` with another credential (a `/login`),
// `<provider> unchecked` with a credential that cannot be resolved (PRDCT-4540).
// The terminal form's usage (PRDCT-4551 with PRDCT-4540): with
// `PI_STAND_IN_TERMINAL_USAGE=1`, each request leaves one assistant message
// with made-up usage in a Pi session file under `PI_STAND_IN_STATE`, its
// header naming the tab's `--session-id`, written a moment after the request
// and stamped with the time the request left, as Pi stamps a fast answer:
// on the real Pi 1.5.2 that time is earlier than a watch of Clave's state
// folder sees the extension's report (the verifier's finding 2).
let terminalSessionFile = null
async function terminalUsage(provider, sentAt) {
  const dir = process.env.PI_STAND_IN_STATE
  const id = flags['--session-id'] ?? flags['--session']
  if (process.env.PI_STAND_IN_TERMINAL_USAGE !== '1' || !dir || !id) return
  await new Promise((resolve) => setTimeout(resolve, 1500))
  mkdirSync(dir, { recursive: true })
  const at = new Date(sentAt).toISOString()
  if (!terminalSessionFile) {
    terminalSessionFile = path.join(dir, `${at.replace(/[:.]/g, '-')}_${id}.jsonl`)
    appendFileSync(
      terminalSessionFile,
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: process.cwd() })}\n`
    )
  }
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'stand-in',
    provider,
    model: 'stand-in',
    usage: {
      input: 100,
      output: 10,
      cacheRead: 20,
      cacheWrite: 0,
      totalTokens: 130,
      cost: { input: 0.0001, output: 0.00002, cacheRead: 0.00001, cacheWrite: 0, total: 0.00013 }
    },
    stopReason: 'stop',
    timestamp: sentAt
  }
  appendFileSync(
    terminalSessionFile,
    `${JSON.stringify({ type: 'message', id: randomUUID().slice(0, 8), parentId: null, timestamp: at, message })}\n`
  )
}
if (flags['--mode'] === undefined && process.env.PI_STAND_IN_TERMINAL === '1') {
  await piClaveTools('terminal')
  process.stdout.write('stub pi terminal\r\n')
  const control = process.env.PI_STAND_IN_TERMINAL_CONTROL
  let seen = ''
  setInterval(() => {
    if (!control || !existsSync(control)) return
    const line = readFileSync(control, 'utf8').trim()
    if (!line || line === seen) return
    seen = line
    const [provider, how] = line.split(' ')
    void providerRequest('tui', provider, () => {}, how).then(() =>
      terminalUsage(provider, Date.now())
    )
  }, 200)
  await new Promise(() => {})
}
if (flags['--mode'] !== 'rpc') {
  process.stderr.write(
    'usage: pi-rpc-agent.mjs --mode rpc [--session-dir d] [--session-id id | --session id|path | --no-session] [--model m] [--provider p] [--thinking l]\n'
  )
  process.exit(2)
}
// Pi 1.5.2's own refusal, before it speaks the protocol (checked by hand:
// `pi --provider kimi-coding --mode rpc` prints this and exits 1).
if (flags['--provider'] !== undefined && flags['--model'] === undefined) {
  process.stderr.write(
    `Error: --provider requires --model (for example: --provider ${flags['--provider']} --model <pattern>)\n`
  )
  process.exit(1)
}
const stateDir = flags['--session-dir'] ?? process.env.PI_STAND_IN_STATE
if (!stateDir) {
  process.stderr.write('PI_STAND_IN_STATE or --session-dir is required\n')
  process.exit(2)
}
mkdirSync(stateDir, { recursive: true })
const framesFile = path.join(stateDir, 'frames.jsonl')
const delayMs = Number(process.env.PI_STAND_IN_DELAY_MS ?? 0) || 0
const longTurnMs = Number(process.env.PI_STAND_IN_LONG_TURN_MS ?? 1000) || 1000
// Pi 1.5.2 answers a prompt once its run is prepared, and starts the run
// (`agent_start`) in a later write: a client reads the two apart, and a
// second prompt sent in between is refused, the run being Pi's already
// (PRDCT-4566). The stand-in leaves this long between them.
const START_GAP_MS = 20
const noModel = process.env.PI_STAND_IN_NO_MODEL === '1'
const anyProvider = process.env.PI_STAND_IN_ANY_PROVIDER === '1'
let streamingOnce = process.env.PI_STAND_IN_STREAMING_ONCE === '1'
const idleSteer = process.env.PI_STAND_IN_IDLE_STEER
// A `clear_queue` that reaches Pi as it takes its next steer: answered once
// that steer's user message has started, the steer no longer in the answer
// (PRDCT-4566, verifier 3's finding 2).
const clearAfterStep = process.env.PI_STAND_IN_CLEAR_AFTER_STEP === '1'
/** The ids of the `clear_queue` commands held back until the next steer. */
const heldClears = []
// Pi 1.5.2's abort clears no queue: what was queued stays held for a next
// run (PRDCT-4566, the verifier's closing look, finding 2).
const abortKeepsQueue = process.env.PI_STAND_IN_ABORT_KEEPS_QUEUE === '1'
// Pi 1.5.2's own window between taking a steer off its queue and starting
// its user message, which a `clear_queue` answer still lists the steer in
// (PRDCT-4566, the verifier's closing look, finding 3).
const drainGapMs = Number(process.env.PI_STAND_IN_DRAIN_GAP_MS ?? 0) || 0
/** The steer taken off the queue in that window, until it is listed once or
 *  its user message starts. */
let draining

const LEVELS = ['low', 'high', 'max']
const modelObject = (id) => ({
  id,
  name: `Stand-in ${id}`,
  api: 'stand-in',
  provider: 'stand-in',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192
})
const CATALOG = ['one', 'two', 'three'].map(modelObject)
// Real Pi lists every provider it finds a credential for (Pi 1.5.2, PRDCT-4496):
// with `PI_STAND_IN_ENV_PROVIDERS=1`, an `ANTHROPIC_API_KEY` in the
// environment lists Anthropic's model too, and `set_model` takes it.
const envProviders = process.env.PI_STAND_IN_ENV_PROVIDERS === '1'
if (envProviders && process.env.ANTHROPIC_API_KEY)
  CATALOG.push({ ...modelObject('claude-stand-in'), provider: 'anthropic' })
/** The model a connection's directory declares, listed beside the catalog. */
const declared = []
// A declared model is listed, so `set_model` takes it too, as Pi does.
const findModel = (provider, id) =>
  [...declared, ...CATALOG].find((m) => m.provider === provider && m.id === id)
const COMMANDS = [
  { name: 'init', description: 'Write an AGENTS.md for this folder' },
  { name: 'compact', description: 'Summarize the conversation' }
].map((command) => ({
  ...command,
  source: 'prompt',
  sourceInfo: {
    path: `stand-in:${command.name}`,
    source: 'stand-in',
    scope: 'temporary',
    origin: 'top-level'
  }
}))

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const ok = (id, command, data) =>
  out({ id, type: 'response', command, success: true, ...(data !== undefined ? { data } : {}) })
const fail = (id, command, error) => out({ id, type: 'response', command, success: false, error })
const now = () => new Date().toISOString()
const entryId = () => randomBytes(4).toString('hex')

// ---- the session, in Pi's own file format ----

const session = {
  id: '',
  file: undefined,
  // Whether the file is on disk: Pi writes it at the session's first
  // message (the header, then every entry so far), never at its creation
  // (PRDCT-4427, verifier round 1 Major 2). Until then `--session <id>`
  // finds nothing.
  written: false,
  header: undefined,
  entries: [],
  name: undefined,
  model: undefined,
  thinkingLevel: 'high'
}
const sessionFiles = () =>
  readdirSync(stateDir)
    .filter((name) => name.endsWith('.jsonl') && name !== 'frames.jsonl')
    .map((name) => path.join(stateDir, name))
const headerOf = (file) => {
  try {
    const first = readFileSync(file, 'utf8').split('\n')[0]
    const header = JSON.parse(first)
    return header && header.type === 'session' ? header : undefined
  } catch {
    return undefined
  }
}
const fileFor = (id) => sessionFiles().find((file) => headerOf(file)?.id === id)

function append(entry) {
  const parentId = session.entries.length ? session.entries[session.entries.length - 1].id : null
  const full = { type: entry.type, id: entryId(), parentId, timestamp: now(), ...entry }
  session.entries.push(full)
  if (!session.file) return full
  if (session.written) appendFileSync(session.file, `${JSON.stringify(full)}\n`)
  else if (full.type === 'message') {
    // The first message: the file appears, the header then every entry.
    session.written = true
    appendFileSync(
      session.file,
      [session.header, ...session.entries].map((line) => `${JSON.stringify(line)}\n`).join('')
    )
  }
  return full
}
function create(id) {
  session.id = id
  session.entries = []
  session.name = undefined
  const timestamp = now()
  session.file = noSession
    ? undefined
    : path.join(stateDir, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
  session.written = false
  session.header = { type: 'session', version: 3, id, timestamp, cwd: process.cwd() }
  if (session.model)
    append({ type: 'model_change', provider: session.model.provider, modelId: session.model.id })
}
function open(file) {
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
  session.id = lines[0].id
  session.file = file
  session.written = true
  session.header = lines[0]
  session.entries = lines.slice(1)
  session.name = undefined
  for (const entry of session.entries) {
    if (entry.type === 'model_change' && !flags['--model'])
      session.model = findModel(entry.provider, entry.modelId) ?? session.model
    if (entry.type === 'thinking_level_change') session.thinkingLevel = entry.thinkingLevel
    if (entry.type === 'session_info') session.name = entry.name
  }
}
const messages = () =>
  session.entries.filter((entry) => entry.type === 'message').map((entry) => entry.message)

// The model from the flags; the catalog's first otherwise.
if (!noModel) {
  const pattern = flags['--model']
  if (pattern) {
    const slash = pattern.indexOf('/')
    const provider = slash >= 0 ? pattern.slice(0, slash) : (flags['--provider'] ?? 'stand-in')
    const id = slash >= 0 ? pattern.slice(slash + 1) : pattern
    session.model =
      findModel(provider, id) ??
      // A provider a connection's directory declares, as real Pi reads it
      // from that directory's models.json.
      (anyProvider && provider !== 'stand-in' ? { ...modelObject(id), provider } : undefined)
    // A name that provider does not have (`no-such-model…`): Pi 1.5.2 keeps
    // it as a custom model id, says so on stderr, and does not list it
    // (checked by hand: `--provider kimi-coding --model no-such-model-zz`).
    if (session.model && !findModel(provider, id)) {
      if (/^no-such-model/.test(id))
        process.stderr.write(
          `Warning: Model "${id}" not found for provider "${provider}". Using custom model id.\n`
        )
      else declared.push(session.model)
    }
    if (!session.model) {
      process.stderr.write(`Model not found: ${provider}/${id}\n`)
      process.exit(1)
    }
  } else session.model = CATALOG[0]
}
if (flags['--thinking'] && LEVELS.includes(flags['--thinking']))
  session.thinkingLevel = flags['--thinking']

if (flags['--session']) {
  const wanted = flags['--session']
  const file =
    existsSync(wanted) && headerOf(wanted)
      ? wanted
      : sessionFiles().find((candidate) => headerOf(candidate)?.id === wanted)
  if (!file) {
    process.stderr.write(`Session not found: ${wanted}\n`)
    process.exit(1)
  }
  open(file)
} else if (flags['--session-id'] && !noSession) {
  const file = fileFor(flags['--session-id'])
  if (file) open(file)
  else create(flags['--session-id'])
} else create(flags['--session-id'] ?? randomUUID())

// ---- the run ----

/** The run in flight: its abort, its queues, the dialog it waits on. */
let run
const steering = []
const followUp = []
const dialogs = new Map()

class Aborted extends Error {}
const sleep = (ms) =>
  new Promise((resolve, reject) => {
    if (run?.aborted) return reject(new Aborted())
    if (ms <= 0) return resolve()
    const timer = setTimeout(() => {
      run.wake = undefined
      resolve()
    }, ms)
    run.wake = () => {
      clearTimeout(timer)
      reject(new Aborted())
    }
  })
const emit = async (event) => {
  await sleep(delayMs)
  out(event)
}
// What a model call used, as Pi 1.5.2 writes it on each assistant message
// (read off a real session on 14 November 2026, PRDCT-4551): made-up figures,
// the same for every call, so a spec can count calls.
const usage = () => ({
  input: 100,
  output: 10,
  cacheRead: 20,
  cacheWrite: 0,
  totalTokens: 130,
  cost: { input: 0.0001, output: 0.00002, cacheRead: 0.00001, cacheWrite: 0, total: 0.00013 }
})
const assistant = (content, stopReason, extra = {}) => ({
  role: 'assistant',
  content,
  api: 'stand-in',
  provider: session.model?.provider ?? 'stand-in',
  model: session.model?.id ?? 'none',
  usage: usage(),
  stopReason,
  timestamp: Date.now(),
  ...extra
})
const update = (message, assistantMessageEvent) =>
  emit({ type: 'message_update', message, assistantMessageEvent })

/** The queue cleared and said, as Pi answers `clear_queue`: a steer taken off
 *  it whose user message has not started yet is said too, and starts anyway. */
function clearQueue(id) {
  const listed = draining === undefined ? [] : [draining]
  draining = undefined
  const cleared = { steering: [...listed, ...steering], followUp: [...followUp] }
  steering.length = 0
  followUp.length = 0
  ok(id, 'clear_queue', cleared)
  out({ type: 'queue_update', steering: [], followUp: [] })
}
/** `taken`: a steer or a follow-up Pi takes off its queue, which answers a
 *  `clear_queue` held back for it (PI_STAND_IN_CLEAR_AFTER_STEP). */
async function userMessage(text, taken = false) {
  const message = { role: 'user', content: text, timestamp: Date.now() }
  await emit({ type: 'message_start', message })
  if (taken) draining = undefined
  if (taken) for (const id of heldClears.splice(0)) clearQueue(id)
  await emit({ type: 'message_end', message })
  append({ type: 'message', message })
  run.messages.push(message)
}

/** One assistant message of text deltas; `before` runs once the message has
 *  started and may return more deltas to lead with; `pauseMs` waits between
 *  two deltas (an abort cuts it short). */
async function textMessage(deltas, before, pauseMs = 0) {
  run.current = assistant([], 'pending')
  await emit({ type: 'message_start', message: run.current })
  const lead = before ? await before() : []
  await update(run.current, { type: 'text_start', contentIndex: 0 })
  let text = ''
  for (const [index, delta] of [...lead, ...deltas].entries()) {
    if (index > 0 && pauseMs) await sleep(pauseMs)
    text += delta
    run.current.content = [{ type: 'text', text }]
    await update(run.current, { type: 'text_delta', contentIndex: 0, delta })
  }
  await update(run.current, { type: 'text_end', contentIndex: 0, content: text })
  return text
}
async function endMessage(message) {
  run.current = undefined
  await emit({ type: 'message_end', message })
  append({ type: 'message', message })
  run.messages.push(message)
}
async function echoTurn(text) {
  await emit({ type: 'turn_start' })
  await userMessage(text, true)
  const reply = await textMessage(['You said: ', text])
  const message = assistant([{ type: 'text', text: reply }], 'stop')
  await endMessage(message)
  await emit({ type: 'turn_end', message, toolResults: [] })
}
async function deliverSteering() {
  while (steering.length) {
    const text = steering.shift()
    if (drainGapMs) {
      // Off the queue, still listed until its user message starts.
      draining = text
      await sleep(drainGapMs)
    }
    await emit({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
    await echoTurn(text)
  }
}

async function confirmDialog() {
  const id = randomUUID()
  const answer = new Promise((resolve) => dialogs.set(id, resolve))
  out({
    type: 'extension_ui_request',
    id,
    method: 'confirm',
    title: 'Proceed?',
    message: 'The stand-in asks.'
  })
  const wake = new Promise((_, reject) => {
    run.wake = () => reject(new Aborted())
  })
  const frame = await Promise.race([answer, wake])
  run.wake = undefined
  return frame.confirmed === true && frame.cancelled !== true ? 'confirmed' : 'cancelled'
}

async function startRun(text) {
  run = { aborted: false, messages: [], current: undefined, wake: undefined }
  // PRDCT-4540, the verifier's R3-1: an extension of the person's own that
  // moves Pi to another provider before each run (`provider/model`).
  const move = process.env.PI_STAND_IN_MOVE_BEFORE_RUN
  if (move) {
    const [provider, id] = move.split('/')
    session.model = findModel(provider, id) ?? { ...modelObject(id), provider }
  }
  // PRDCT-4540, the verifier's finding 1: an extension of the person's own
  // whose virtual model, listed under the session's provider (the
  // connection's), is selected before each run (`<id>`).
  const virtual = process.env.PI_STAND_IN_VIRTUAL_BEFORE_RUN
  if (virtual && session.model)
    session.model = { ...modelObject(virtual), provider: session.model.provider, api: 'pi-virtual' }
  try {
    // The prompt was answered in a write of its own; the run starts in the
    // next (START_GAP_MS).
    await sleep(START_GAP_MS)
    await emit({ type: 'agent_start' })
    if (text.includes('retry')) {
      await emit({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'rate limited'
      })
      await emit({ type: 'auto_retry_end', success: true, attempt: 1 })
    }
    await emit({ type: 'turn_start' })
    await userMessage(text)
    // The provider request, through Clave's extension when it watches.
    await providerRequest(
      'rpc',
      session.model?.provider,
      () => {
        run.aborted = true
      },
      undefined,
      session.model?.api
    )
    if (run.aborted) throw new Aborted()
    if (text.includes('notify extension'))
      out({
        type: 'extension_ui_request',
        id: randomUUID(),
        method: 'notify',
        message: 'Stand-in notice',
        notifyType: 'info'
      })
    if (text.includes('fail provider')) {
      run.current = assistant([], 'pending')
      await emit({ type: 'message_start', message: run.current })
      const message = assistant([], 'error', { errorMessage: 'Provider refused: stand-in' })
      await endMessage(message)
      await emit({ type: 'turn_end', message, toolResults: [] })
      await emit({ type: 'agent_end', messages: run.messages, willRetry: false })
      await emit({ type: 'agent_settled', aborted: false })
      return
    }
    // `clave-open {…}` / `clave-call <tool> {…}`: the model calls that tool
    // once with those arguments (PRDCT-4507), says what came back, and ends
    // its turn.
    const call = claveCallOf(text)
    if (call) {
      const opened = call.args
        ? await callClaveTool(await claveServerReady, call.name, call.args)
        : { ok: false, error: 'bad arguments' }
      await textMessage([`${call.name}: ${JSON.stringify(opened)}`])
      const message = assistant(
        [{ type: 'text', text: `${call.name}: ${JSON.stringify(opened)}` }],
        'stop'
      )
      await endMessage(message)
      await emit({ type: 'turn_end', message, toolResults: [] })
      await emit({ type: 'agent_end', messages: run.messages, willRetry: false })
      await emit({ type: 'agent_settled', aborted: false })
      return
    }
    // `long turn`: the echo streams in three pieces a second apart (or
    // `PI_STAND_IN_LONG_TURN_MS`), as a model's long answer does while the
    // person writes more (PRDCT-4566).
    const long = text.includes('long turn')
    const half = Math.ceil(text.length / 2)
    const said = await textMessage(
      long ? ['You said: ', text.slice(0, half), text.slice(half)] : ['You said: ', text],
      async () => {
        const lead = text.includes('ask extension') ? [`confirm: ${await confirmDialog()}. `] : []
        if (text.includes('slow')) await sleep(20_000)
        return lead
      },
      long ? longTurnMs : 0
    )
    const toolCall = {
      type: 'toolCall',
      id: 'tc_1',
      name: 'read',
      arguments: { path: 'README.md' }
    }
    await update(run.current, {
      type: 'toolcall_start',
      contentIndex: 1,
      id: 'tc_1',
      toolName: 'read'
    })
    await update(run.current, {
      type: 'toolcall_delta',
      contentIndex: 1,
      delta: '{"path":"README.md"}'
    })
    await update(run.current, { type: 'toolcall_end', contentIndex: 1, toolCall })
    const first = assistant([{ type: 'text', text: said }, toolCall], 'toolUse')
    await endMessage(first)
    await emit({
      type: 'tool_execution_start',
      toolCallId: 'tc_1',
      toolName: 'read',
      args: { path: 'README.md' }
    })
    const result = { content: [{ type: 'text', text: '# Stand-in' }], details: {} }
    await emit({
      type: 'tool_execution_end',
      toolCallId: 'tc_1',
      toolName: 'read',
      result,
      isError: false
    })
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'tc_1',
      toolName: 'read',
      content: result.content,
      isError: false,
      timestamp: Date.now()
    }
    append({ type: 'message', message: toolResult })
    run.messages.push(toolResult)
    await emit({ type: 'turn_end', message: first, toolResults: [toolResult] })
    await deliverSteering()
    await emit({ type: 'turn_start' })
    await textMessage(['Done.'])
    const second = assistant([{ type: 'text', text: 'Done.' }], 'stop')
    await endMessage(second)
    await emit({ type: 'turn_end', message: second, toolResults: [] })
    await deliverSteering()
    while (followUp.length) {
      const next = followUp.shift()
      await emit({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
      await echoTurn(next)
      await deliverSteering()
    }
    await emit({ type: 'agent_end', messages: run.messages, willRetry: false })
    await emit({ type: 'agent_settled', aborted: false })
  } catch (error) {
    if (!(error instanceof Aborted)) throw error
    // The run stops where it is, its queues dropped, or kept when told to.
    if (!abortKeepsQueue) {
      steering.length = 0
      followUp.length = 0
    }
    const partial = run.current?.content ?? []
    await endMessageNow(assistant(partial, 'aborted', { errorMessage: 'Request was aborted' }))
    out({ type: 'agent_end', messages: run.messages, willRetry: false })
    out({ type: 'agent_settled', aborted: true })
  } finally {
    const finished = run
    run = undefined
    draining = undefined
    // A clear held back for a step that never came is answered at the end.
    for (const id of heldClears.splice(0)) clearQueue(id)
    for (const respond of finished.onSettled ?? []) respond()
  }
}
async function endMessageNow(message) {
  run.current = undefined
  out({ type: 'message_end', message })
  append({ type: 'message', message })
  run.messages.push(message)
}

function queue(list, text, id, command) {
  list.push(text)
  ok(id, command, { disposition: 'queued' })
  out({ type: 'queue_update', steering: [...steering], followUp: [...followUp] })
}

// ---- commands ----

function stateData() {
  return {
    ...(session.model && !noModel ? { model: session.model } : {}),
    thinkingLevel: session.thinkingLevel,
    isStreaming: run !== undefined,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    ...(session.file ? { sessionFile: session.file } : {}),
    sessionId: session.id,
    ...(session.name ? { sessionName: session.name } : {}),
    autoCompactionEnabled: true,
    messageCount: messages().length,
    pendingMessageCount: steering.length + followUp.length
  }
}

function handle(frame) {
  const { id, type } = frame
  if (type === 'extension_ui_response') {
    const resolve = dialogs.get(frame.id)
    if (resolve) {
      dialogs.delete(frame.id)
      resolve(frame)
    }
    return
  }
  switch (type) {
    case 'get_state':
      return ok(id, type, stateData())
    case 'get_messages':
      return ok(id, type, { messages: messages() })
    case 'get_entries': {
      const since = frame.since
      const index = since ? session.entries.findIndex((entry) => entry.id === since) : -1
      if (since && index === -1) return fail(id, type, `Entry not found: ${since}`)
      const entries = since ? session.entries.slice(index + 1) : session.entries
      const leaf = session.entries[session.entries.length - 1]
      return ok(id, type, { entries, leafId: leaf ? leaf.id : null })
    }
    case 'get_commands':
      return ok(id, type, { commands: COMMANDS })
    case 'get_available_models':
      return ok(id, type, { models: [...declared, ...CATALOG] })
    case 'get_available_thinking_levels':
      return ok(id, type, { levels: LEVELS })
    case 'get_session_stats': {
      const all = messages()
      const count = (role) => all.filter((m) => m.role === role).length
      const tokens = 12 * all.length
      return ok(id, type, {
        ...(session.file ? { sessionFile: session.file } : {}),
        sessionId: session.id,
        userMessages: count('user'),
        assistantMessages: count('assistant'),
        toolCalls: all
          .filter((m) => m.role === 'assistant')
          .flatMap((m) => m.content)
          .filter((block) => block.type === 'toolCall').length,
        toolResults: count('toolResult'),
        totalMessages: all.length,
        tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
        cost: 0,
        ...(session.model && !noModel
          ? {
              contextUsage: {
                tokens,
                contextWindow: 200000,
                percent: (tokens / 200000) * 100
              }
            }
          : {})
      })
    }
    case 'set_model': {
      const model = findModel(frame.provider, frame.modelId)
      if (!model) return fail(id, type, `Model not found: ${frame.provider}/${frame.modelId}`)
      session.model = model
      append({ type: 'model_change', provider: model.provider, modelId: model.id })
      return ok(id, type, model)
    }
    case 'set_thinking_level': {
      if (!LEVELS.includes(frame.level))
        return fail(id, type, `Invalid thinking level: ${frame.level}`)
      session.thinkingLevel = frame.level
      append({ type: 'thinking_level_change', thinkingLevel: frame.level })
      ok(id, type)
      return out({ type: 'thinking_level_changed', level: frame.level })
    }
    case 'set_session_name':
      session.name = String(frame.name ?? '')
      append({ type: 'session_info', name: session.name })
      ok(id, type)
      return out({ type: 'session_info_changed', name: session.name })
    case 'new_session':
      if (run) return fail(id, type, 'Agent is streaming')
      create(randomUUID())
      return ok(id, type, { cancelled: false })
    case 'switch_session': {
      const target = frame.sessionPath
      if (typeof target !== 'string' || !existsSync(target) || !headerOf(target))
        return fail(id, type, `Session not found: ${target}`)
      if (run) return fail(id, type, 'Agent is streaming')
      open(target)
      return ok(id, type, { cancelled: false })
    }
    case 'clear_queue':
      // Held back until Pi takes its next steer, when told to.
      if (clearAfterStep && run && steering.length) return void heldClears.push(id)
      return clearQueue(id)
    case 'abort': {
      if (!run) return ok(id, type)
      run.aborted = true
      ;(run.onSettled ??= []).push(() => ok(id, type))
      run.wake?.()
      return
    }
    case 'prompt': {
      const text = String(frame.message ?? '')
      if (run) {
        if (frame.streamingBehavior === 'steer') return queue(steering, text, id, type)
        if (frame.streamingBehavior === 'followUp') return queue(followUp, text, id, type)
        // Pi 1.5.2's own words for a bare prompt while a run is going.
        return fail(
          id,
          type,
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
        )
      }
      if (streamingOnce) {
        // Refused as if a run were going, though none is; once.
        streamingOnce = false
        return fail(id, type, 'Agent is streaming')
      }
      if (noModel || !session.model) return fail(id, type, 'No model selected')
      // `use anthropic`: the model moves to Anthropic's during the run, as an
      // extension's command typed in the chat could move it (PRDCT-4496).
      const other = text.includes('use anthropic')
        ? CATALOG.find((m) => m.provider === 'anthropic')
        : undefined
      if (other) {
        session.model = other
        append({ type: 'model_change', provider: other.provider, modelId: other.id })
      }
      ok(id, type, { disposition: 'started' })
      void startRun(text)
      return
    }
    case 'steer':
    case 'follow_up': {
      const text = String(frame.message ?? '')
      if (run) return queue(type === 'steer' ? steering : followUp, text, id, type)
      // Idle, told to, as Pi 1.5.2 does: the steer is answered queued and
      // nothing starts; Pi holds it in its queue, and its next run takes it
      // (PRDCT-4566).
      if (type === 'steer' && idleSteer === 'queue') return queue(steering, text, id, type)
      // Idle: nothing to steer, so the message starts a run of its own.
      if (noModel || !session.model) return fail(id, type, 'No model selected')
      ok(id, type, { disposition: 'queued' })
      void startRun(text)
      return
    }
    default:
      return fail(id, type, `Unknown command: ${type}`)
  }
}

let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  let end
  while ((end = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, end).replace(/\r$/, '')
    pending = pending.slice(end + 1)
    if (!line.trim()) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch (error) {
      out({
        type: 'response',
        command: 'parse',
        success: false,
        error: `Failed to parse command: ${error.message}`
      })
      continue
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue
    appendFileSync(framesFile, `${JSON.stringify({ t: Date.now(), frame })}\n`)
    handle(frame)
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
// PRDCT-4507: in the background, as Pi connects its servers at session start.
void piClaveTools('rpc')
