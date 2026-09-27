import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { claudeAccountsManager } from './claude-accounts'
import { codexAccountsManager } from './codex-accounts'
import { resolvePosixShellLaunch } from './shell-launch'
import { getLoginShellEnv, getUserShell } from './sessions/adapters/pty-backend'

/**
 * The login flows (ADR 0002): a provider's own login command, run in a
 * hidden PTY owned by this process, its output watched for the link the user
 * must open and for the credential's arrival, never rendered.
 *
 *  - Claude runs `claude setup-token`. The command opens the browser itself
 *    and prints the token once the browser flow completes; the token is
 *    captured by its shape and stored encrypted through the accounts
 *    manager. When the browser cannot reach the CLI back, the CLI asks for
 *    a code to paste: `sendInput` types it in.
 *  - Codex runs `codex login` with `CODEX_HOME` set to the account's own
 *    home, so the credential lands in that home's `auth.json` and nowhere
 *    else; the run is done when the file is there. An API-key account runs
 *    `codex login --with-api-key` with the key on stdin, no PTY.
 *
 * Progress crosses to every window as a job (`accounts:login-progress`);
 * a job never carries a credential, and the captured PTY output is kept
 * only long enough to find the link and the token in it.
 */
export type LoginProvider = 'claude' | 'codex'
export type LoginStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface LoginJob {
  id: string
  provider: LoginProvider
  accountId: string
  status: LoginStatus
  /** The link the command printed for the user's browser, when found. */
  url: string | null
  /** True once the command asked for a code to paste (Claude's fallback). */
  awaitingCode: boolean
  /** A short reason on failure, with nothing secret in it. */
  message: string | null
  startedAt: number
}

/** A wide pane so a long token or link never wraps across two lines. */
const PTY_COLS = 400
const PTY_ROWS = 40
/** Nobody signs in for longer than this; the browser tab is gone by then. */
const LOGIN_TIMEOUT_MS = 10 * 60_000
/** How much stripped output is kept for the scans, oldest dropped first. */
const OUTPUT_KEEP = 16 * 1024
/** The token, and something after it. The scan runs on every chunk, so a
 *  token cut by a chunk boundary looks like a shorter token until the rest
 *  arrives: the read waits for the character that ends it (a newline, a
 *  space, the next line's boundary) rather than take the buffer's end for
 *  one. `findClaudeToken` on exit appends that newline itself. */
const CLAUDE_TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/
const URL_RE = /https?:\/\/[^\s'"<>)\]]+/g
/** Claude Code's wording when the local callback did not happen. */
const CLAUDE_CODE_PROMPT_RE = /paste (the )?code/i

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

/** The link a login command printed: the first web address in its output.
 *  Pure, for the tests. */
export function findLoginUrl(text: string): string | null {
  const matches = text.match(URL_RE)
  return matches ? matches[0].replace(/[.,;:]+$/, '') : null
}

/** The token `claude setup-token` printed, if it has. Pure, for the tests. */
export function findClaudeToken(text: string): string | null {
  const match = CLAUDE_TOKEN_RE.exec(text)
  return match ? match[0] : null
}

type Listener = (job: LoginJob) => void

interface LiveJob {
  job: LoginJob
  process: pty.IPty | null
  output: string
  timer: ReturnType<typeof setTimeout>
  finish: (status: LoginStatus, message?: string | null) => void
}

class AccountLoginManager {
  private jobs = new Map<string, LiveJob>()
  private listeners = new Set<Listener>()

  onProgress(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Every job still running, for a window that just opened. */
  list(): LoginJob[] {
    return [...this.jobs.values()].map((live) => ({ ...live.job }))
  }

  private emit(live: LiveJob): void {
    const snapshot = { ...live.job }
    for (const listener of this.listeners) listener(snapshot)
  }

  /** One login per account at a time: a second click joins the first. */
  private runningFor(provider: LoginProvider, accountId: string): LoginJob | null {
    for (const live of this.jobs.values()) {
      if (live.job.provider === provider && live.job.accountId === accountId) return { ...live.job }
    }
    return null
  }

  /** The environment a login runs in: the user's login shell, the tokens a
   *  shell may export stripped so the CLI signs in afresh, and the account's
   *  own home for Codex. */
  private loginEnv(provider: LoginProvider, accountId: string): Record<string, string> {
    const env: Record<string, string> = { ...getLoginShellEnv(), TERM: 'xterm-256color' }
    delete env.CLAUDECODE
    if (provider === 'claude') {
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      delete env.ANTHROPIC_API_KEY
    } else {
      const home = codexAccountsManager.syncHome(accountId, env)
      if (home) env.CODEX_HOME = home
      else delete env.OPENAI_API_KEY
    }
    return env
  }

  private startJob(
    provider: LoginProvider,
    accountId: string,
    command: string,
    env: Record<string, string>,
    onOutput: (live: LiveJob) => void,
    onExit: (live: LiveJob, code: number) => void
  ): LoginJob {
    const id = randomUUID()
    const job: LoginJob = {
      id,
      provider,
      accountId,
      status: 'running',
      url: null,
      awaitingCode: false,
      message: null,
      startedAt: Date.now()
    }
    const launch = resolvePosixShellLaunch(getUserShell(), command)
    const live: LiveJob = {
      job,
      process: null,
      output: '',
      timer: setTimeout(() => live.finish('failed', 'The login took too long.'), LOGIN_TIMEOUT_MS),
      finish: (status, message = null) => {
        if (live.job.status !== 'running') return
        clearTimeout(live.timer)
        live.job.status = status
        live.job.message = message
        live.output = ''
        const process = live.process
        live.process = null
        try {
          process?.kill()
        } catch {
          // Already gone.
        }
        this.jobs.delete(id)
        this.emit(live)
      }
    }
    this.jobs.set(id, live)
    try {
      live.process = pty.spawn(launch.file, launch.args, {
        name: 'xterm-256color',
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: env.HOME || process.cwd(),
        env
      })
    } catch (error) {
      live.finish('failed', error instanceof Error ? error.message : 'Could not start the login.')
      return { ...job }
    }
    live.process.onData((chunk) => {
      if (live.job.status !== 'running') return
      live.output = (live.output + stripAnsi(chunk)).slice(-OUTPUT_KEEP)
      const url = live.job.url ?? findLoginUrl(live.output)
      const changed = url !== live.job.url
      live.job.url = url
      onOutput(live)
      if (changed && live.job.status === 'running') this.emit(live)
    })
    live.process.onExit(({ exitCode }) => {
      if (live.job.status !== 'running') return
      onExit(live, exitCode)
    })
    this.emit(live)
    return { ...job }
  }

  /** `claude setup-token` for the account; done once the token is stored. */
  startClaudeLogin(accountId: string): LoginJob {
    const account = claudeAccountsManager.get(accountId)
    if (!account || accountId === 'default') throw new Error('Add an account to log into.')
    const running = this.runningFor('claude', accountId)
    if (running) return running
    const store = (live: LiveJob, token: string): void => {
      try {
        claudeAccountsManager.setToken(accountId, token)
        live.finish('done')
      } catch (error) {
        live.finish('failed', error instanceof Error ? error.message : 'Could not store the token.')
      }
    }
    return this.startJob(
      'claude',
      accountId,
      'exec claude setup-token',
      this.loginEnv('claude', accountId),
      (live) => {
        const token = findClaudeToken(live.output)
        if (token) {
          store(live, token)
          return
        }
        if (!live.job.awaitingCode && CLAUDE_CODE_PROMPT_RE.test(live.output)) {
          live.job.awaitingCode = true
          this.emit(live)
        }
      },
      (live, code) => {
        // The command is over, so the buffer's end is the token's end too.
        const token = findClaudeToken(live.output + '\n')
        if (token) {
          store(live, token)
          return
        }
        live.finish(
          'failed',
          code === 0
            ? 'The command ended without printing a token.'
            : `claude setup-token exited with status ${code}.`
        )
      }
    )
  }

  /** `codex login` on the account's home; done once its `auth.json` is there. */
  startCodexLogin(accountId: string): LoginJob {
    const account = codexAccountsManager.get(accountId)
    if (!account) throw new Error('Unknown Codex account')
    const running = this.runningFor('codex', accountId)
    if (running) return running
    const env = this.loginEnv('codex', accountId)
    return this.startJob(
      'codex',
      accountId,
      'exec codex login',
      env,
      () => {},
      (live, code) => {
        if (codexAccountsManager.hasCredential(accountId, env)) {
          codexAccountsManager.notifyChanged()
          live.finish('done')
        } else {
          live.finish(
            'failed',
            code === 0
              ? 'The command ended without signing in.'
              : `codex login exited with status ${code}.`
          )
        }
      }
    )
  }

  /** `codex login --with-api-key`, the key on stdin: no browser, no PTY. */
  startCodexApiKeyLogin(accountId: string, apiKey: string): Promise<LoginJob> {
    const account = codexAccountsManager.get(accountId)
    if (!account) throw new Error('Unknown Codex account')
    const key = apiKey.trim()
    if (!key) throw new Error('Paste the API key first.')
    const env = this.loginEnv('codex', accountId)
    const id = randomUUID()
    const job: LoginJob = {
      id,
      provider: 'codex',
      accountId,
      status: 'running',
      url: null,
      awaitingCode: false,
      message: null,
      startedAt: Date.now()
    }
    return new Promise((resolve) => {
      const launch = resolvePosixShellLaunch(getUserShell(), 'exec codex login --with-api-key')
      const child = spawnProcess(launch.file, launch.args, {
        cwd: env.HOME || process.cwd(),
        env,
        stdio: ['pipe', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2048)
      })
      const done = (status: LoginStatus, message: string | null): void => {
        job.status = status
        job.message = message
        for (const listener of this.listeners) listener({ ...job })
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

  /** Type into the login's terminal: the code Claude asks for when the
   *  browser could not reach it. */
  sendInput(jobId: string, text: string): void {
    const live = this.jobs.get(jobId)
    if (!live?.process || live.job.status !== 'running') return
    live.process.write(`${text.trim()}\r`)
  }

  cancel(jobId: string): void {
    this.jobs.get(jobId)?.finish('cancelled')
  }

  cancelAll(): void {
    for (const live of [...this.jobs.values()]) live.finish('cancelled')
  }
}

export const accountLoginManager = new AccountLoginManager()
