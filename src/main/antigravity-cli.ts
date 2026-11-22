/**
 * What Clave reads from the Antigravity CLI outside a conversation: the mode
 * it starts on, its models and the plan's limits. All of it through agy's own
 * documented surface; Clave never touches its credential.
 *
 * No Electron here, and the login shell's environment is loaded on first use:
 * the settings source imports this at boot and its graph must not reach the
 * terminal backend (`settings/boot-graph.test.ts`).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { devNull, homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { antigravityDefaultMode, parseAntigravityModels } from '../shared/antigravity'
import type { ModelOption } from '../shared/session-model'
import { findExecutable } from './shell-launch'
import { launchProfileManager } from './launch-profile-manager'
import {
  AccountUsageManager,
  type UsageError,
  type UsageLimits,
  type UsageWindow
} from './usage-manager'

const TIMEOUT_MS = 30_000
const SIGN_IN = 'Sign in to Antigravity to see its usage: run agy in a terminal.'
const NOT_INSTALLED = 'Antigravity CLI is not installed on this machine.'

interface CliOptions {
  /** The login shell's environment when omitted. */
  env?: Record<string, string>
  /** The binary: `agy`, or the selected profile's. */
  command?: string
}

/** The mode a chat starts on when nothing names one (`antigravityDefaultMode`). */
export function readAntigravityStartMode(env: { HOME?: string } = {}): string {
  const file = join(env.HOME || homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  try {
    return antigravityDefaultMode(readFileSync(file, 'utf8'))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? antigravityDefaultMode(null)
      : 'default'
  }
}

/** What a profile's `--settings` (inline JSON, or a path) says about
 *  permissions. */
export interface ProfileSettings {
  /** Its `agentMode`: where a tab starts, under a pick. */
  start?: string
  /** `strict`, or settings that do not read: asks, in both transports. */
  strict?: true
  /** Rules a terminal is handed with the file and a chat cannot be:
   *  `agy acp` takes no `--settings`, so a chat under them asks. */
  rules?: true
}

function parseSettings(settings: string, cwd: string): Record<string, unknown> | undefined {
  try {
    const text = settings.trimStart().startsWith('{')
      ? settings
      : readFileSync(resolvePath(cwd, settings), 'utf8')
    const said: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    return said && typeof said === 'object' && !Array.isArray(said)
      ? (said as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function readProfileSettings(settings: string | undefined, cwd: string): ProfileSettings {
  if (settings === undefined) return {}
  const said = parseSettings(settings, cwd)
  if (!said) return { strict: true }
  const { agentMode, toolPermission, permissions } = said
  const ruled =
    (permissions !== undefined &&
      (typeof permissions !== 'object' ||
        permissions === null ||
        Object.keys(permissions).length > 0)) ||
    said.allowNonWorkspaceAccess === false ||
    said.enableTerminalSandbox === true
  return {
    ...(agentMode !== undefined
      ? { start: antigravityDefaultMode(JSON.stringify({ agentMode })) }
      : {}),
    ...(toolPermission === 'strict' ? { strict: true as const } : {}),
    ...(ruled ? { rules: true as const } : {})
  }
}

let askFolder: string | undefined

/** A profile's settings file as a terminal in Ask is handed it: untouched
 *  when it already asks, else a copy that does, in a folder only the person
 *  can read (it may hold keys, so never the command line). Undefined when
 *  none can be made. */
export function settingsFileThatAsks(file: string, cwd: string): string | undefined {
  const said = parseSettings(file, cwd)
  if (!said) return undefined
  if (said.agentMode === '') return file
  try {
    if (!askFolder || !existsSync(askFolder))
      askFolder = mkdtempSync(join(tmpdir(), 'clave-agy-settings-'))
    const name = createHash('sha256').update(resolvePath(cwd, file)).digest('hex')
    const copy = join(askFolder, `${name}.json`)
    writeFileSync(copy, JSON.stringify({ ...said, agentMode: '' }), { mode: 0o600 })
    return copy
  } catch {
    return undefined
  }
}

/** An empty folder of this process's own: agy reads project configuration
 *  from where it runs, and the temp folder of a shared machine is anybody's.
 *  Made again when the system reaped it. */
let privateCwd: string | undefined
function ownFolder(): string {
  if (!privateCwd || !existsSync(privateCwd)) privateCwd = mkdtempSync(join(tmpdir(), 'clave-agy-'))
  return privateCwd
}

interface Ran {
  ok: boolean
  missing: boolean
  stdout: string
  stderr: string
}

/** One short agy command: in a folder of its own, so it reads no project, its log
 *  thrown away (a read every five minutes would fill the person's log
 *  folder), its stdin closed (`-p` waits on an open one). */
async function runAgy(args: string[], options: CliOptions): Promise<Ran> {
  const env = options.env ?? (await import('./sessions/adapters/pty-backend')).getLoginShellEnv()
  const command = options.command ?? 'agy'
  // Windows resolves the name itself: the lookup reads POSIX paths only.
  const file = process.platform === 'win32' ? command : findExecutable(command, env.PATH)
  if (!file) return { ok: false, missing: true, stdout: '', stderr: '' }
  const cwd = ownFolder()
  return new Promise((resolve) => {
    const child = execFile(
      file,
      ['--log-file', devNull, ...args],
      {
        cwd,
        env,
        timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) =>
        resolve({ ok: !error, missing: error?.code === 'ENOENT', stdout, stderr })
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end()
  })
}

/** The models, one per model with its levels. Rejects when none can be read. */
export async function listAntigravityModels(options: CliOptions = {}): Promise<ModelOption[]> {
  const ran = await runAgy(['models'], options)
  if (ran.missing) throw new Error(NOT_INSTALLED)
  const models = ran.ok ? parseAntigravityModels(ran.stdout) : []
  if (models.length === 0) throw new Error('Antigravity could not list its models')
  return models
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** `agy --output-format json -p /usage`'s structured half (`command.data`),
 *  never its printed table, whose percentages are rounded. Each group of
 *  models has a weekly and a five-hour bucket; the group is the window's
 *  scope. */
export function normalizeAntigravityLimits(value: unknown, now = Date.now()): UsageLimits {
  const { groups } = record(record(record(value).command).data)
  if (!Array.isArray(groups)) throw new Error('No usage groups')
  const windows: UsageWindow[] = []
  for (const group of groups.map(record)) {
    const named = typeof group.name === 'string' ? group.name.replace(/\s+models$/i, '').trim() : ''
    // The scope is a chart column's and the foot's word, a few characters
    // wide ("Claude/GPT"); the tooltip's label keeps the CLI's own.
    const scope = named.replace(/\s+and\s+/gi, '/') || null
    for (const bucket of (Array.isArray(group.buckets) ? group.buckets : []).map(record)) {
      const { id, window, remaining_fraction: left, reset_time: reset, disabled } = bucket
      if (disabled === true || typeof id !== 'string') continue
      if (typeof left !== 'number' || !Number.isFinite(left)) continue
      const weekly = window === 'weekly'
      const session = window === '5h'
      const span = weekly ? 'Weekly' : session ? '5-hour' : 'Usage window'
      const resetsAt = typeof reset === 'string' ? Date.parse(reset) : NaN
      windows.push({
        key: id,
        label: named ? `${span} · ${named}` : span,
        kind: weekly ? (scope ? 'weekly_scoped' : 'weekly_all') : session ? 'session' : 'quota',
        scope,
        usedPercentage: Math.max(0, Math.min(100, (1 - left) * 100)),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        severity: null
      })
    }
  }
  return { windows, fetchedAt: now }
}

/** The plan's limits. A signed-out `agy -p /usage` starts a Google sign-in
 *  and waits a minute on it, and this read runs unattended: `agy models`,
 *  which only refuses, is asked first. */
export async function readAntigravityLimits(
  options: CliOptions = {}
): Promise<UsageLimits | UsageError> {
  const signedIn = await runAgy(['models'], options)
  if (signedIn.missing) return { error: NOT_INSTALLED }
  if (!signedIn.ok)
    return /sign in|log ?in|authenticat/i.test(signedIn.stderr)
      ? { error: SIGN_IN }
      : { error: 'Could not reach Antigravity. Check your connection, then retry.' }
  // An exit 0 proves nothing by itself: only a model listed is a sign-in.
  if (parseAntigravityModels(signedIn.stdout).length === 0) return { error: SIGN_IN }
  const ran = await runAgy(
    ['--print-timeout', '20s', '--output-format', 'json', '-p', '/usage'],
    options
  )
  if (!ran.ok) {
    const said = `${ran.stderr}\n${ran.stdout}`
    if (/api[ _-]?key/i.test(said))
      return {
        windows: [],
        fetchedAt: Date.now(),
        message: 'Antigravity is using an API key. Plan limits do not apply.'
      }
    return /authentication/i.test(said)
      ? { error: SIGN_IN }
      : { error: 'Could not read Antigravity usage. Check your connection, then retry.' }
  }
  try {
    return normalizeAntigravityLimits(JSON.parse(ran.stdout))
  } catch {
    return {
      error: 'Antigravity returned an unexpected usage response. Try updating Antigravity CLI.'
    }
  }
}

/** The binary of the profile a launch would resolve, as the chat runs it. */
export function antigravityCommand(): string {
  try {
    return launchProfileManager.resolve('antigravity').command[0] ?? 'agy'
  } catch {
    // A default naming a profile that is gone: the launch says so, a read need not.
    return 'agy'
  }
}

export const ANTIGRAVITY_ACCOUNT_ID = 'default'

/** One account, the CLI's own sign-in. No clock of its own: each read is two
 *  agy processes, so it is read when a window looks, at most every five
 *  minutes unless forced. */
export const antigravityUsageManager = new AccountUsageManager(
  {
    ids: () => [ANTIGRAVITY_ACCOUNT_ID],
    exists: (id) => id === ANTIGRAVITY_ACCOUNT_ID,
    read: () => readAntigravityLimits({ command: antigravityCommand() })
  },
  ANTIGRAVITY_ACCOUNT_ID
)
