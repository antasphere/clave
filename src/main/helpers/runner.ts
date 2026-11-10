import { execFile, type ChildProcess } from 'child_process'
import { basename } from 'path'
import {
  accountTokenForSpawn,
  getLoginShellEnv,
  getUserShell
} from '../sessions/adapters/pty-backend'
import { launchProfileManager } from '../launch-profile-manager'
import { buildOneShotLaunch } from '../claude-one-shot'
import type { HelperFailureReason } from '../../shared/helper-prompt'
import {
  helperConfig,
  type HelperConfig,
  type HelperDefinition,
  type HelperLaunchContext,
  type HelperOutcome
} from './registry'

/**
 * The one runner every helper goes through (README.md beside this file): one
 * queue ordered by priority, a cap on the children running at once, and every
 * child ended on the quit. A `claude -p` is a child of this process in its own
 * process group, so nothing of the sessions' shutdown reaches it on its own:
 * wave 3's verifier found one alive after the server had stopped (PRDCT-3375).
 * The handles are held here so `cancelAll` ends them with the rest, and
 * `shutdown` shuts the door so nothing asked during the quit spawns a CLI
 * nothing would kill.
 */

/** Background helpers (`background: true`, the digests) running at once,
 *  all together. The others are not counted here: a title or a git call
 *  never waits for a digest to end. */
export const MAX_RUNNING_HELPERS = 3
/** How long a cancelled child gets to leave on SIGTERM before SIGKILL. */
export const HELPER_CANCEL_GRACE_MS = 1000

export { helperCliArgs } from './cli-args'
import { helperCliArgs } from './cli-args'

/** What the CLI's failure says it was. `killed` is execFile's own timeout. */
export function classifyFailure(input: {
  killed?: boolean
  message?: string
  stderr?: string
  stdout?: string
}): Exclude<HelperFailureReason, 'unreadable' | 'cancelled' | 'disabled'> {
  if (input.killed) return 'timeout'
  const text = [input.message, input.stderr, input.stdout].filter(Boolean).join('\n')
  if (LIMIT_RE.test(text)) return 'limit'
  if (AUTH_RE.test(text)) return 'auth'
  return 'failed'
}
/**
 * The CLI's own notice ("Claude AI usage limit reached|…", "Failed to
 * authenticate. API Error: 401 …", "Invalid API key · Please run /login"),
 * or null. Recognised by how the reply OPENS: its first non-empty line must
 * start with one of the CLI's own notice openings, whatever follows and
 * however long. A model that answered a message about quotas or a 401 does
 * not open with those exact words ("Usage limit handling: …", "API errors
 * (401, 429) are retried"), so its reply stays unreadable and is retried.
 */
export function cliNotice(stdout: string): 'limit' | 'auth' | null {
  const first = stdout
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return null
  if (LIMIT_NOTICE.test(first)) return 'limit'
  if (AUTH_NOTICE.test(first)) return 'auth'
  return null
}
const LIMIT_NOTICE =
  /^(?:Claude (?:AI )?usage limit reached\b|You've (?:hit|reached) your (?:usage |session |weekly )?limit\b|(?:5-hour|weekly|Opus|Fable|Sonnet) limit reached\b|API Error: 429\b|You're out of extra usage\b)/i
const AUTH_NOTICE =
  /^(?:Invalid API key\b|Not logged in\b|Please run \/login\b|Failed to authenticate\b|OAuth (?:access )?token (?:has )?(?:expired|been revoked|is invalid)\b|API Error: 40[13]\b|Credit balance is too low\b)/i

const LIMIT_RE =
  /usage limit|rate[ -]limit|limit reached|limit will reset|\b429\b|quota|out of extra usage/i
const AUTH_RE =
  /\b401\b|\b403\b|invalid (?:api key|bearer|x-api-key)|not logged in|please run \/login|authentication|unauthori[sz]ed|oauth token|token (?:has )?(?:expired|revoked)|credit balance|account (?:is )?no longer available/i

interface Job {
  definition: HelperDefinition<unknown, unknown>
  input: unknown
  context: HelperLaunchContext
  owner?: string
  seq: number
  resolve: (outcome: HelperOutcome<unknown>) => void
}

const queue: Job[] = []
const runningById = new Map<string, number>()
const runningByPool = new Map<string, number>()
let runningBackground = 0
let seq = 0
let closed = false
const children = new Map<ChildProcess, string>()
const cancelled = new WeakSet<ChildProcess>()
/** Jobs `cancelAll` refused while they were between two attempts. */
let generation = 0

export interface RunOptions {
  /** Who asked (a session id): `cancelQueued(owner)` refuses its waiting jobs. */
  owner?: string
}

/** Run a helper in its turn. Never rejects: every way it can end is an outcome. */
// ── PRDCT-4327 (digests lane): the account rule, exported so the end-to-end
// harness's stand-in for a read resolves the account the way a run does. ──
/** The Claude account a helper runs on: the one chosen for the helper (its
 *  config, `helperConfig`) over the caller's; `null` there is the machine
 *  login, `undefined` the caller's account. */
export function helperAccountId(
  config: Pick<HelperConfig, 'claudeProfileId'>,
  context: HelperLaunchContext
): string | undefined {
  return config.claudeProfileId !== undefined
    ? (config.claudeProfileId ?? undefined)
    : context.claudeProfileId
}

export function runHelper<Input, Output>(
  definition: HelperDefinition<Input, Output>,
  input: Input,
  context: HelperLaunchContext = {},
  options: RunOptions = {}
): Promise<HelperOutcome<Output>> {
  if (closed) return Promise.resolve(failure('cancelled', 'Clave is quitting'))
  if (!helperConfig(definition).enabled)
    return Promise.resolve(failure('disabled', `${definition.label} is switched off`))
  return new Promise((resolve) => {
    queue.push({
      definition: definition as HelperDefinition<unknown, unknown>,
      input,
      context,
      owner: options.owner,
      seq: ++seq,
      resolve: resolve as (outcome: HelperOutcome<unknown>) => void
    })
    pump()
  })
}

function failure(
  reason: HelperFailureReason,
  detail: string
): { ok: false; reason: HelperFailureReason; detail: string } {
  return { ok: false, reason, detail }
}

/** Whether a job may start now: under its helper's cap, its pool's, and,
 *  for background work, the background cap. */
function mayStart(definition: HelperDefinition<unknown, unknown>): boolean {
  if ((runningById.get(definition.id) ?? 0) >= (definition.concurrency ?? Infinity)) return false
  const pool = definition.pool
  if (pool && (runningByPool.get(pool.id) ?? 0) >= pool.concurrency) return false
  if (definition.background && runningBackground >= MAX_RUNNING_HELPERS) return false
  return true
}

/** Whether `job` starts before `other`. Inside one pool, in the order they
 *  were asked, whatever their helpers' priorities: the exchange digests
 *  must not starve the work-card titles beside them, which ran first come,
 *  first served before the helpers. Otherwise the higher priority, then the
 *  older. */
function startsBefore(job: Job, other: Job): boolean {
  const pool = job.definition.pool?.id
  if (pool !== undefined && pool === other.definition.pool?.id) return job.seq < other.seq
  if (job.definition.priority !== other.definition.priority)
    return job.definition.priority > other.definition.priority
  return job.seq < other.seq
}

/** The next job that may start: the highest priority under its caps, the
 *  oldest of equals. */
function nextJob(): number {
  let best = -1
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i]
    if (!mayStart(job.definition)) continue
    if (best === -1) {
      best = i
      continue
    }
    if (startsBefore(job, queue[best])) best = i
  }
  return best
}

function count(definition: HelperDefinition<unknown, unknown>, delta: 1 | -1): void {
  runningById.set(definition.id, (runningById.get(definition.id) ?? 0) + delta)
  if (definition.pool)
    runningByPool.set(definition.pool.id, (runningByPool.get(definition.pool.id) ?? 0) + delta)
  if (definition.background) runningBackground += delta
}

function pump(): void {
  for (;;) {
    const index = nextJob()
    if (index === -1) return
    const [job] = queue.splice(index, 1)
    count(job.definition, 1)
    void execute(job)
      .catch((error: unknown) =>
        failure('failed', error instanceof Error ? error.message : String(error))
      )
      .then((outcome) => {
        count(job.definition, -1)
        job.resolve(outcome)
        pump()
      })
  }
}

async function execute(job: Job): Promise<HelperOutcome<unknown>> {
  const { definition } = job
  const attempts = Math.max(1, definition.attempts ?? 1)
  const born = generation
  let last: HelperOutcome<unknown> = failure('failed', 'Not run')
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (closed || generation !== born) return failure('cancelled', 'Cancelled')
    const config = helperConfig(definition)
    let stdout:
      | { ok: true; stdout: string; stderr: string }
      | { ok: false; reason: HelperFailureReason; detail: string }
    try {
      stdout = await spawnOnce(job, config, born)
    } catch (error) {
      // The launch refused before any child: an account removed under the
      // tab is the usual one. Not worth a retry.
      const detail = error instanceof Error ? error.message : String(error)
      return failure(classifyFailure({ message: detail }), detail)
    }
    if (!stdout.ok) {
      last = stdout
      if (stdout.reason === 'cancelled') return stdout
      if (stdout.reason !== 'failed' && !definition.retryAnyFailure) return stdout
      if (attempt < attempts)
        console.warn(`[helpers] ${definition.id}: ${stdout.reason} on try ${attempt}, retrying`)
      continue
    }
    const value = definition.parseReply(stdout.stdout, job.input)
    if (value !== null && value !== undefined)
      return { ok: true, value, attempts: attempt, model: config.model }
    // A reply that is the CLI's own refusal, printed on stdout with exit 0:
    // only the notice as the whole reply, never a keyword inside an answer.
    // Nothing that parses: the notice may be on stdout or, with exit 0, on
    // stderr alone.
    const onStdout = cliNotice(stdout.stdout)
    const said = onStdout ?? cliNotice(stdout.stderr)
    if (said) return failure(said, (onStdout ? stdout.stdout : stdout.stderr).trim().slice(0, 300))
    last = failure('unreadable', stdout.stdout.trim().slice(0, 300) || 'Empty reply')
    if (attempt < attempts)
      console.warn(
        `[helpers] ${definition.id}: unreadable reply on try ${attempt}, retrying: ${JSON.stringify(stdout.stdout.slice(0, 120))}`
      )
  }
  return last
}

async function spawnOnce(
  job: Job,
  config: HelperConfig,
  born: number
): Promise<
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; reason: HelperFailureReason; detail: string }
> {
  const { definition, context } = job
  // An account chosen for the helper replaces the session's; the machine
  // login (null) carries neither a token nor the legacy config dir.
  const onOwnAccount = config.claudeProfileId !== undefined
  const accountId = helperAccountId(config, context)
  const profile = launchProfileManager.resolveClaudeCli(
    context.workspaceId,
    context.launchProfileId
  )
  const shot = buildOneShotLaunch({
    profile,
    args: helperCliArgs(definition.systemPrompt, config),
    loginEnv: getLoginShellEnv(),
    account: {
      configDir: onOwnAccount ? undefined : context.configDir,
      oauthToken: await accountTokenForSpawn('claude', accountId)
    },
    userShell: getUserShell()
  })
  // The account's token is read across an await: a `cancelAll` (or the
  // quit) in between must not be followed by a child nothing would signal.
  if (closed || generation !== born) return failure('cancelled', 'Cancelled')
  const prompt = definition.buildPrompt(job.input)
  return new Promise((resolve) => {
    // execFile calls back once; held to it, so a slot is never freed twice.
    let settled = false
    const child = execFile(
      shot.file,
      shot.args,
      {
        env: shot.env,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: definition.timeoutMs
      },
      (err, stdout, stderr) => {
        if (settled) return
        settled = true
        children.delete(child)
        if (cancelled.has(child)) {
          resolve(failure('cancelled', 'Cancelled'))
          return
        }
        if (err) {
          const { killed, code } = err as { killed?: boolean; code?: unknown }
          // "Command failed: <file> <every argument>" carries the system
          // prompt: what the call said is its exit and its stderr, not that.
          const head = err.message.startsWith('Command failed')
            ? `exit code ${String(code)}`
            : err.message
          const reason = classifyFailure({ killed: killed === true, message: head, stderr, stdout })
          // 127 is the login shell's "command not found": said the way the
          // panel recognises it (`describeClaudeFailure`), not as a bare code.
          const missing =
            code === 127 ? `${basename(profile.command[0] ?? 'claude')}: command not found` : null
          const detail =
            reason === 'timeout'
              ? `No answer in ${Math.round(definition.timeoutMs / 1000)} s`
              : [missing ?? head, stderr?.trim() || stdout?.trim()].filter(Boolean).join(' — ')
          console.warn(`[helpers] ${definition.id}: ${reason}: ${detail.slice(0, 300)}`)
          resolve(failure(reason, detail))
          return
        }
        resolve({ ok: true, stdout, stderr: stderr ?? '' })
      }
    )
    children.set(child, definition.id)
    // If the CLI exits before the prompt is written, the callback above says
    // why; an unhandled 'error' on stdin would end the whole process.
    child.stdin?.on?.('error', (error) => {
      console.warn(`[helpers] ${definition.id}: stdin error (ignored):`, error.message)
    })
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

/** End every helper: the queued ones are answered `cancelled`, the running
 *  CLIs signalled (SIGTERM, then SIGKILL after the grace) and their answers,
 *  if one still comes, dropped. The door stays open: the sessions' shutdown
 *  also runs when the last window closes on macOS, which is not a quit. */
export function cancelAll(): void {
  generation++
  for (const job of queue.splice(0)) job.resolve(failure('cancelled', 'Cancelled'))
  for (const child of [...children.keys()]) {
    cancelled.add(child)
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
    }, HELPER_CANCEL_GRACE_MS)
    hard.unref?.()
    child.once?.('exit', () => clearTimeout(hard))
  }
}

/** The quit's call: every helper ended as `cancelAll` does, and the door
 *  shut, so nothing asked during the quit starts a CLI. */
export function shutdown(): void {
  closed = true
  cancelAll()
}

export function isShutDown(): boolean {
  return closed
}

/** Refuse the jobs an owner (a closed tab) still has waiting. */
export function cancelQueued(owner: string): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].owner !== owner) continue
    const [job] = queue.splice(i, 1)
    job.resolve(failure('cancelled', 'Cancelled'))
  }
}

/** The CLI children running right now, of one helper or of all (test seam). */
export function runningHelpers(id?: string): number {
  if (id === undefined) return children.size
  return [...children.values()].filter((helper) => helper === id).length
}

/** The jobs waiting their turn (test seam). */
export function queuedHelpers(): string[] {
  return queue.map((job) => job.definition.id)
}

/** Open the door again (test seam: the module is one per process). */
export function resetShutdownForTests(): void {
  closed = false
}
