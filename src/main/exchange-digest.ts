import { execFile, type ChildProcess } from 'child_process'
import { DigestStore } from './exchange-digest-store'
import { settingsPorts } from './ports'
import {
  accountTokenForSpawn,
  getLoginShellEnv,
  getUserShell
} from './sessions/adapters/pty-backend'
import { launchProfileManager } from './launch-profile-manager'
import { TEST_NO_ACTIVATE } from './test-mode'
import { buildOneShotLaunch } from './claude-one-shot'
import {
  digestPrompt,
  parseDigestReply,
  type DigestDone,
  type DigestLaunch,
  type DigestRequest,
  type DigestResult
} from '../shared/exchange-digest'
import {
  clipNotes,
  parseWorkDigestReply,
  placeNote,
  workDigestBucket,
  workDigestPrompt,
  type WorkDigestDone,
  type WorkDigestRequest,
  type WorkDigestResult
} from '../shared/work-digest'

/**
 * The exchange digest's one-shot (`src/shared/exchange-digest.ts` says what it
 * is for): one short Haiku turn with no tool, no skill and no MCP server, the
 * way a tab title is named (`TITLE_CLI_ARGS`), Sonnet if Haiku is not to be
 * had. It runs the agent the session runs, on the session's account. One at a
 * time, since a reader scrolling through history mounts many timelines at
 * once, and every child is ended on the quit (`cancelAll`), as the titles'
 * are: a `claude -p` nothing kills outlives the app (PRDCT-3375).
 *
 * The WORK digest (`src/shared/work-digest.ts`, the title of a card of the
 * agent's working notes, PRDCT-4212) rides the same queue, the same child and
 * the same file, under keys of its own (`work-…`): one runner for every
 * one-shot the chat views ask for.
 */

export const DIGEST_TIMEOUT_MS = 45_000

export const DIGEST_CLI_ARGS = [
  '-p',
  '--model',
  'haiku',
  '--fallback-model',
  'sonnet',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--disable-slash-commands',
  '--tools',
  ''
]

/** The digest of a timeline never needs more than its latest messages. */
const MAX_MESSAGES = 30
/** Nor more than this of any one message. */
const MAX_CHARS = 4000

/** One one-shot waiting its turn: what to send, whose account, and who
 *  takes the model's reply (or the failure). */
interface Job {
  launch: DigestLaunch
  prompt: string
  what: string
  resolve: (reply: { ok: true; stdout: string } | { ok: false; error: string }) => void
}

const queue: Job[] = []
/** Two at a time: a session with several fresh timelines is read in step. */
const MAX_RUNNING = 2
let running = 0
const children = new Set<ChildProcess>()
let closed = false

const clip = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text

/** The digests read so far, filed by session (exchange-digest-store.ts),
 *  in Clave's data folder through the storage port rather than Electron's
 *  `app`: this module is loaded by the session manager, which the standalone
 *  server runs under Bun, where an import of Electron ends the process before
 *  it announces itself. Inside the app the port is Electron's own data folder,
 *  so the file is where it was. */
let store: DigestStore | null = null
const digests = (): DigestStore =>
  (store ??= new DigestStore(settingsPorts().storage.pathOf('exchange-digests.json')))

/** The same messages asked for twice at once (both views of a tab, a remount)
 *  share one call. */
const inflight = new Map<string, Promise<DigestResult>>()

/** Every exchange digest read for a tab: what its timelines show on opening. */
export function digestsOf(sessionId: string): Record<string, DigestDone> {
  return digests().of(sessionId)
}

/** Every work digest read for a tab (its own bucket, `workDigestBucket`):
 *  what its cards are titled on opening. */
export function workDigestsOf(sessionId: string): Record<string, WorkDigestDone> {
  return digests().of(workDigestBucket(sessionId)) as unknown as Record<string, WorkDigestDone>
}

/** A timeline's digest: the one filed for these messages, or a call read now
 *  and filed when it answers. */
export function requestDigest(request: DigestRequest): Promise<DigestResult> {
  if (closed) return Promise.resolve({ ok: false, error: 'Clave is quitting' })
  if (!request.messages.length) return Promise.resolve({ ok: false, error: 'No messages' })
  const filed = digests().get(request.sessionId, request.key)
  if (filed) return Promise.resolve(filed)
  const id = `${request.sessionId}|${request.key}`
  const running = inflight.get(id)
  if (running) return running
  const ask = read(request).then((result) => {
    inflight.delete(id)
    if (result.ok) digests().put(request.sessionId, request.key, result)
    return result
  })
  inflight.set(id, ask)
  return ask
}

/** The digest of a stretch of working notes: the one filed for these notes,
 *  or a call read now and filed when it answers (`work-digest.ts`). */
export function requestWorkDigest(request: WorkDigestRequest): Promise<WorkDigestResult> {
  if (closed) return Promise.resolve({ ok: false, error: 'Clave is quitting' })
  if (!request.notes.length) return Promise.resolve({ ok: false, error: 'No notes' })
  const bucket = workDigestBucket(request.sessionId)
  const filed = digests().get(bucket, request.key) as unknown as WorkDigestDone | undefined
  if (filed) return Promise.resolve(filed)
  const id = `${bucket}|${request.key}`
  const running = workInflight.get(id)
  if (running) return running
  const ask = readWork(request).then((result) => {
    workInflight.delete(id)
    if (result.ok) digests().put(bucket, request.key, result as unknown as DigestDone)
    return result
  })
  workInflight.set(id, ask)
  return ask
}
const workInflight = new Map<string, Promise<WorkDigestResult>>()

function read(request: DigestRequest): Promise<DigestResult> {
  // Under the end-to-end harness no model is called: a spec that wants a
  // digest hands the model's reply in CLAVE_E2E_DIGEST_REPLY, read the way a
  // real one is, after a beat so the reading state shows.
  if (TEST_NO_ACTIVATE) {
    const reply = process.env.CLAVE_E2E_DIGEST_REPLY
    if (!reply) return Promise.resolve({ ok: false, error: 'No model under test' })
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            parseDigestReply(reply, request.messages.length) ?? {
              ok: false,
              error: 'Unreadable test reply'
            }
          ),
        600
      )
    )
  }
  const messages = request.messages.slice(-MAX_MESSAGES).map((message) => ({
    from: message.from,
    text: clip(message.text) ?? '',
    request: clip(message.request),
    reply: clip(message.reply)
  }))
  const offset = request.messages.length - messages.length
  return oneShot(request.launch, digestPrompt(messages), `${messages.length} message(s)`).then(
    (reply) => {
      if (!reply.ok) return reply
      const parsed = parseDigestReply(reply.stdout, messages.length)
      if (!parsed) {
        console.warn('[exchange-digest] unreadable reply:', reply.stdout.slice(0, 200))
        return { ok: false, error: 'The model did not answer in the asked shape' }
      }
      return { ...parsed, message: parsed.message === null ? null : parsed.message + offset }
    }
  )
}

function readWork(request: WorkDigestRequest): Promise<WorkDigestResult> {
  // Under the harness, the reply comes from CLAVE_E2E_WORK_DIGEST_REPLY.
  if (TEST_NO_ACTIVATE) {
    const reply = process.env.CLAVE_E2E_WORK_DIGEST_REPLY
    if (!reply) return Promise.resolve({ ok: false, error: 'No model under test' })
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            parseWorkDigestReply(reply, request.notes.length) ?? {
              ok: false,
              error: 'Unreadable test reply'
            }
          ),
        600
      )
    )
  }
  const { notes, offset } = clipNotes(request.notes)
  return oneShot(
    request.launch,
    workDigestPrompt(notes, request.tools),
    `${notes.length} note(s)`
  ).then((reply) => {
    if (!reply.ok) return reply
    const parsed = parseWorkDigestReply(reply.stdout, notes.length)
    if (!parsed) {
      console.warn('[exchange-digest] unreadable work reply:', reply.stdout.slice(0, 200))
      return { ok: false, error: 'The model did not answer in the asked shape' }
    }
    return placeNote(parsed, offset)
  })
}

/** One prompt to the model, in its turn in the queue. */
function oneShot(
  launch: DigestLaunch,
  prompt: string,
  what: string
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    queue.push({ launch, prompt, what, resolve })
    void next()
  })
}

async function next(): Promise<void> {
  if (running >= MAX_RUNNING) return
  const job = queue.shift()
  if (!job) return
  running++
  // Room for another beside this one: start it now, not once this one ends.
  void next()
  const started = Date.now()
  console.log(`[exchange-digest] reading ${job.what}, ${queue.length} waiting`)
  try {
    const result = await run(job)
    console.log(
      `[exchange-digest] ${result.ok ? 'answered' : `failed: ${result.error.slice(0, 120)}`} in ${Date.now() - started}ms`
    )
    job.resolve(result)
  } catch (error) {
    job.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
  } finally {
    running--
    void next()
  }
}

async function run(job: Job): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const { launch } = job
  const shot = buildOneShotLaunch({
    profile: launchProfileManager.resolveClaudeCli(launch.workspaceId, launch.launchProfileId),
    args: DIGEST_CLI_ARGS,
    loginEnv: getLoginShellEnv(),
    account: {
      configDir: launch.configDir,
      oauthToken: await accountTokenForSpawn('claude', launch.claudeProfileId)
    },
    userShell: getUserShell()
  })
  return new Promise((resolve) => {
    const child = execFile(
      shot.file,
      shot.args,
      { env: shot.env, encoding: 'utf-8', maxBuffer: 1024 * 1024, timeout: DIGEST_TIMEOUT_MS },
      (err, stdout, stderr) => {
        children.delete(child)
        if (err) {
          console.error('[exchange-digest] claude CLI error:', err.message, stderr)
          resolve({ ok: false, error: stderr || err.message })
          return
        }
        resolve({ ok: true, stdout })
      }
    )
    children.add(child)
    child.stdin?.write(job.prompt)
    child.stdin?.end()
  })
}

/** End every queued and running digest: the sessions' shutdown calls it with
 *  the titles' (`pty-manager.ts` killAll); `quit` also shuts the door. */
export function cancelAll(quit = false): void {
  if (quit) closed = true
  store?.flush()
  for (const job of queue.splice(0)) job.resolve({ ok: false, error: 'Cancelled' })
  for (const child of [...children]) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    const hard = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 1000)
    child.once('exit', () => clearTimeout(hard))
  }
}
