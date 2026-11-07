import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolvePosixShellLaunch, shellSingleQuote } from './shell-launch'
import {
  AccountUsageManager,
  type UsageError,
  type UsageLimits,
  type UsageWindow
} from './usage-manager'
import { codexAccountsManager, DEFAULT_CODEX_ACCOUNT_ID } from './codex-accounts'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function durationLabel(minutes: unknown): string {
  if (!finite(minutes) || minutes <= 0) return 'Usage window'
  if (minutes === 10080) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}

/** The multi-bucket response owns the list. The legacy bucket is a fallback,
 * not another allowance to count. Neither primary nor secondary implies 5h. */
export function normalizeCodexLimits(value: unknown): UsageLimits {
  const body = record(value)
  if (!body || !('rateLimits' in body || 'rateLimitsByLimitId' in body)) {
    throw new Error('Codex returned an unexpected usage response. Try updating Codex.')
  }
  const multi = record(body.rateLimitsByLimitId)
  const legacy = record(body.rateLimits)
  const buckets: [string, unknown][] =
    multi && Object.keys(multi).length > 0
      ? Object.entries(multi)
      : legacy
        ? [[typeof legacy.limitId === 'string' ? legacy.limitId : 'codex', legacy]]
        : []
  const windows: UsageWindow[] = []
  // Keep the general allowance first without hiding any additional buckets.
  buckets.sort(([a], [b]) => Number(b === 'codex') - Number(a === 'codex'))
  for (const [id, value] of buckets) {
    const bucket = record(value)
    if (!bucket) continue
    const scope =
      typeof bucket.limitName === 'string' && bucket.limitName.trim()
        ? bucket.limitName.trim()
        : id === 'codex'
          ? null
          : id
    for (const slot of ['primary', 'secondary'] as const) {
      const raw = record(bucket[slot])
      if (!raw || !finite(raw.usedPercent)) continue
      const duration = durationLabel(raw.windowDurationMins)
      const weekly = raw.windowDurationMins === 10080
      windows.push({
        key: `${id}:${slot}`,
        label: scope ? `${duration} · ${scope}` : duration,
        kind: weekly
          ? scope
            ? 'weekly_scoped'
            : 'weekly_all'
          : raw.windowDurationMins === 300
            ? 'session'
            : 'quota',
        scope,
        usedPercentage: Math.max(0, Math.min(100, raw.usedPercent)),
        resetsAt: finite(raw.resetsAt) && raw.resetsAt > 0 ? raw.resetsAt * 1000 : null,
        severity: null
      })
    }
  }
  return { windows, fetchedAt: Date.now() }
}

/** The shell command that starts the app-server on an account's home. The
 *  assignment rides inside the login shell's command, after the profile has
 *  run, so a `CODEX_HOME` the user's own profile exports cannot override the
 *  account's. Exported for the test. */
export function codexAppServerCommand(codexHome?: string): string {
  return codexHome
    ? `exec env CODEX_HOME=${shellSingleQuote(codexHome)} codex app-server`
    : 'exec codex app-server'
}

/** A read-only, short-lived app-server connection. Codex handles its own auth;
 * credentials and account identity never cross into the renderer. No thread or
 * turn is started. A login shell resolves npm/nvm installs in packaged Electron.
 * `codexHome` is an account's own home (ADR 0002); absent, the machine's. */
export function readCodexLimits(codexHome?: string): Promise<UsageLimits | UsageError> {
  return new Promise((resolve) => {
    const launch =
      process.platform === 'win32'
        ? { file: 'codex.cmd', args: ['app-server'] }
        : resolvePosixShellLaunch(process.env.SHELL || '/bin/zsh', codexAppServerCommand(codexHome))
    const child = spawn(launch.file, launch.args, {
      cwd: homedir(),
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    let settled = false
    let buffer = ''
    let expectedId = 1
    const timeout = setTimeout(() => finish({ error: 'Codex usage timed out. Try again.' }), 20_000)
    function finish(result: UsageLimits | UsageError): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdin.end()
      child.kill()
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
      killTimer.unref()
      child.once('close', () => clearTimeout(killTimer))
      resolve(result)
    }
    function send(message: object): void {
      if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    child.on('error', () =>
      finish({ error: 'Could not start Codex. Check that Codex CLI is installed.' })
    )
    child.stdin.on('error', () =>
      finish({ error: 'Could not read Codex usage. Try updating Codex CLI.' })
    )
    child.on('close', () =>
      finish({
        error:
          'Codex closed before returning usage. Check your Codex installation and configuration.'
      })
    )
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      buffer += chunk
      if (buffer.length > 1024 * 1024) {
        finish({ error: 'Codex returned an oversized usage response.' })
        return
      }
      let newline: number
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: Record<string, unknown> | null
        try {
          message = record(JSON.parse(line))
        } catch {
          continue
        }
        if (!message || message.id !== expectedId || 'method' in message) continue
        if (message.error) {
          finish({
            error:
              expectedId === 1
                ? 'Codex could not initialize. Try updating Codex CLI.'
                : 'Could not load Codex account limits. Check your Codex sign-in and connection, then retry.'
          })
          return
        }
        if (expectedId === 1) {
          expectedId = 2
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/read', params: { refreshToken: false } })
        } else if (expectedId === 2) {
          const result = record(message.result)
          const account = record(result?.account)
          if (!account) {
            finish(
              result?.requiresOpenaiAuth === false
                ? {
                    windows: [],
                    fetchedAt: Date.now(),
                    message: 'This Codex provider does not expose ChatGPT subscription limits.'
                  }
                : { error: 'Sign in to Codex CLI with ChatGPT to see your usage limits.' }
            )
          } else if (account.type === 'apiKey' || account.type === 'amazonBedrock') {
            finish({
              windows: [],
              fetchedAt: Date.now(),
              message: 'Codex is using API billing. ChatGPT subscription limits do not apply.'
            })
          } else {
            expectedId = 3
            send({ id: 3, method: 'account/rateLimits/read' })
          }
        } else {
          try {
            finish(normalizeCodexLimits(message.result))
          } catch {
            finish({
              error: 'Codex returned an unexpected usage response. Try updating Codex CLI.'
            })
          }
        }
      }
    })
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'clave_usage', title: 'Clave Usage', version: '1.0.0' }
      }
    })
  })
}

/** The Codex accounts: each read on its own home. An API-key account has no
 *  quota, which the read itself says (`message`, no windows). */
export const codexUsageManager = new AccountUsageManager(
  {
    ids: () => codexAccountsManager.list().map((a) => a.id),
    exists: (id) => !!codexAccountsManager.get(id),
    read: (id) => readCodexLimits(codexAccountsManager.syncHome(id))
  },
  DEFAULT_CODEX_ACCOUNT_ID
)
