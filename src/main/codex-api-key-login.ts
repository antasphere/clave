/**
 * `codex login --with-api-key`, the key on stdin: no browser, no terminal.
 * The one login a Clave server running on its own can take (ADR 0002): the
 * person runs `scripts/server-accounts.mjs codex add-key` on the server,
 * the key reaches the daemon's API in the one redacted field, and this
 * module hands it to Codex's own command with the account's home as
 * `CODEX_HOME`, so the credential lands in that home and nowhere else. The
 * app's login manager (`account-login.ts`) runs the same thing for the
 * Accounts page. Nothing here imports Electron or node-pty, so the daemon
 * can load it whatever runs it.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { LoginJob, LoginStatus } from './account-login'
import { codexAccountsManager } from './codex-accounts'
import { resolvePosixShellLaunch } from './shell-launch'

// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*([@-~])/g
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]/g
/** The CSI final bytes that move the cursor or erase: where one line ends
 *  and another starts, as far as the words are concerned. */
const CURSOR_FINALS = 'ABCDEFGHJKSTdf'

/** Terminal output as words. Colours, titles and modes go; a cursor move,
 *  an erase or a carriage return becomes a line break, because that is what
 *  it was on screen. The CLI paints its frames line by line with cursor
 *  moves rather than newlines (Ink), so dropping them ran the token into the
 *  first word of the line under it — `…Store`, from "Store this token
 *  securely" — and stored a credential the service refuses. */
export function stripAnsi(text: string): string {
  return text
    .replace(CSI_RE, (_match, final: string) => (CURSOR_FINALS.includes(final) ? '\n' : ''))
    .replace(OTHER_ESCAPE_RE, '')
    .replace(/\r\n?/g, '\n')
}

export interface CodexApiKeyLogin {
  accountId: string
  apiKey: string
  /** The login's environment, `CODEX_HOME` set to the account's own home. */
  env: Record<string, string>
  /** The shell the command is launched through (`getUserShell()`). */
  shell: string
  /** Hears the finished job once, before the promise resolves. */
  onDone?: (job: LoginJob) => void
}

/** Runs the login to its end; the job it answers says done or failed, with a
 *  reason that is the command's last line of output and never the key. */
export function runCodexApiKeyLogin(input: CodexApiKeyLogin): Promise<LoginJob> {
  const account = codexAccountsManager.get(input.accountId)
  if (!account) throw new Error('Unknown Codex account')
  const key = input.apiKey.trim()
  if (!key) throw new Error('Paste the API key first.')
  const { accountId, env } = input
  const job: LoginJob = {
    id: randomUUID(),
    provider: 'codex',
    accountId,
    status: 'running',
    url: null,
    awaitingCode: false,
    message: null,
    startedAt: Date.now()
  }
  return new Promise((resolve) => {
    const launch = resolvePosixShellLaunch(input.shell, 'exec codex login --with-api-key')
    const child = spawn(launch.file, launch.args, {
      cwd: env.HOME || process.cwd(),
      env,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2048)
    })
    let settled = false
    const done = (status: LoginStatus, message: string | null): void => {
      if (settled) return
      settled = true
      job.status = status
      job.message = message
      input.onDone?.({ ...job })
      resolve({ ...job })
    }
    child.on('error', (error) => done('failed', error.message))
    child.on('close', (code) => {
      if (codexAccountsManager.hasCredential(accountId, env)) {
        codexAccountsManager.notifyChanged()
        done('done', null)
      } else {
        done(
          'failed',
          stripAnsi(stderr).trim().split('\n').pop() || `codex login exited with status ${code}.`
        )
      }
    })
    child.stdin?.end(`${key}\n`)
  })
}
