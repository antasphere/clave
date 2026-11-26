import { spawn as nodeSpawn } from 'node:child_process'

/**
 * The viewer: one `slideless dev` child per process over a decks root, the Slideless command
 * line's own local server (every file under the root served on loopback, a reload snippet in
 * every page it serves, a reload broadcast when anything under the root changes, the
 * viewer's sandbox headers). What runs is the server's OWN copy of Slideless (PRDCT-4499),
 * never a `slideless` found on a path: the caller gives the command (`ViewerOptions.command`:
 * the Node, the preview host and the copy's script before the viewer's own arguments, and
 * the environment), asked again at every start, so a copy installed after the process
 * started is the one its next start runs. The child's input is a pipe held open and never
 * written: the preview host ends the child when this process's end of that pipe closes,
 * whatever ended this process. Its port is read from the command line's own `--json` line
 * and kept so the next start asks for the same one, its exit noticed and the child started
 * again with a backoff, and it is stopped at `stop`. No copy, or a start that fails, leaves
 * no viewer: the pages are then the caller's own, served as before, with one line saying so.
 */

/** The footer's last line on a deck the viewer serves. */
export const VIEWER_NOTE = 'Served by the Slideless viewer on this Mac'
/** The footer's last line on the plugin's own page, by what the viewer is doing. */
export const NOTES = {
  missing:
    "Clave's Slideless is not installed on this machine yet: Settings › Software Update installs it",
  starting: 'The Slideless viewer is starting; the next open shows this page through it',
  failed: (reason: string): string =>
    `The Slideless viewer could not start (${reason}); this page is served by Clave itself`,
  stopped: 'The Slideless viewer is off; this page is served by Clave itself',
  up: 'The Slideless viewer is up: open this page from Clave again to see it through the viewer'
} as const

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
/** A run this long before an exit counts as healthy: the backoff starts over. */
const HEALTHY_MS = 60_000
/** The CLI prints its URL within this, or the start failed. */
const START_TIMEOUT_MS = 20_000

export type ViewerState =
  | { kind: 'starting' }
  | { kind: 'up'; url: string; port: number }
  /** No copy to run; `note` is the caller's sentence saying so. */
  | { kind: 'missing'; note: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped' }

/** What one start runs: `file` with `args` and then the viewer's own (`devArgs`), in `env`.
 *  For Clave's own copy: its Node, `[<preview host>, <the copy's bin.js>]`, and
 *  `ELECTRON_RUN_AS_NODE` in the environment. */
export interface ViewerCommand {
  file: string
  args: string[]
  env: Record<string, string>
}

/** What the viewer needs of a child process; `child_process.spawn` gives it, a test fakes it. */
export interface ChildLike {
  /** Held open and never written: the preview host's lifeline to this process. */
  stdin: { on(event: 'error', listener: (error: Error) => void): unknown } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type SpawnLike = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildLike

/** What the viewer needs of its own process, to take the child down with it: `process`
 *  gives it, a test fakes it. */
export interface ProcessLike {
  pid: number
  once(event: 'exit' | NodeJS.Signals, listener: () => void): unknown
  off(event: 'exit' | NodeJS.Signals, listener: () => void): unknown
  listenerCount(event: 'exit' | NodeJS.Signals): number
  kill(pid: number, signal: NodeJS.Signals): boolean
}

/** The signals the host, a shell or a crash send the plugin process; on each the child goes
 *  first, then the signal takes its course. */
const PARENT_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP']

export interface ViewerOptions {
  /** The decks root the viewer serves; its `index.html` must exist before the start. */
  root: string
  /** The plugin process itself; the child is killed when it exits or is signalled. */
  proc?: ProcessLike
  /** The port the viewer listened on last time, asked for again; 0 or null for any. */
  savedPort: number | null
  /** Told the port the viewer took, to keep for the next start. */
  onPort?: (port: number) => void
  /** What a start runs, asked again at every start; `{ missing }` when there is no copy to
   *  run, the sentence the state's note is. */
  command: () => Promise<ViewerCommand | { missing: string }>
  spawn?: SpawnLike
  log?: (level: 'info' | 'warn', message: string) => void
  /** The waits between restarts, shortest first; the tests shorten them. */
  backoffMs?: readonly number[]
  startTimeoutMs?: number
  now?: () => number
}

/** The argument list of one start: the subcommand, the root, the port, no browser, JSON out. */
export function devArgs(root: string, port: number): string[] {
  return ['dev', root, '--port', String(port), '--no-open', '--json']
}

/** The URL and port out of the CLI's `--json` line, or null for anything else. */
export function parseDevLine(line: string): { url: string; port: number } | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const url = (raw as { url?: unknown }).url
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    if (!Number.isInteger(port) || port <= 0) return null
    return { url: parsed.origin, port }
  } catch {
    return null
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.trim().slice(0, 200)
}

export class Viewer {
  private current: ViewerState = { kind: 'stopped' }
  private child: ChildLike | null = null
  private attempt: Promise<ViewerState> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** Settles the restart promise a backoff is waiting on, when `stop()` cuts the backoff short. */
  private settleRestart: ((state: ViewerState) => void) | null = null
  private failures = 0
  private stopped = false
  private readonly spawn: SpawnLike
  private readonly backoff: readonly number[]
  private readonly startTimeout: number
  private readonly now: () => number
  private readonly proc: ProcessLike
  private guard: (() => void) | null = null

  constructor(private readonly options: ViewerOptions) {
    this.spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike)
    this.backoff = options.backoffMs ?? BACKOFF_MS
    this.startTimeout = options.startTimeoutMs ?? START_TIMEOUT_MS
    this.now = options.now ?? ((): number => Date.now())
    this.proc = options.proc ?? (process as unknown as ProcessLike)
  }

  /** Takes the child down with the plugin process: at its exit, and on a signal that would
   *  end it (the handler is the only one of its kind, so the signal is raised again once the
   *  child is told; a process with a handler of its own keeps its course). */
  private guardChild(child: ChildLike): void {
    this.unguard()
    const onExit = (): void => {
      child.kill('SIGTERM')
    }
    const onSignal = (signal: NodeJS.Signals) => (): void => {
      child.kill('SIGTERM')
      this.unguard()
      if (this.proc.listenerCount(signal) === 0) this.proc.kill(this.proc.pid, signal)
    }
    const signals = PARENT_SIGNALS.map((signal) => [signal, onSignal(signal)] as const)
    this.proc.once('exit', onExit)
    for (const [signal, listener] of signals) this.proc.once(signal, listener)
    this.guard = (): void => {
      this.proc.off('exit', onExit)
      for (const [signal, listener] of signals) this.proc.off(signal, listener)
    }
  }

  private unguard(): void {
    this.guard?.()
    this.guard = null
  }

  get state(): ViewerState {
    return this.current
  }

  /** The viewer's origin, `http://127.0.0.1:<port>`, while it is up. */
  url(): string | null {
    return this.current.kind === 'up' ? this.current.url : null
  }

  /** The footer's line for the plugin's own page, by what the viewer is doing now. */
  note(): string {
    const s = this.current
    if (s.kind === 'missing') return s.note
    if (s.kind === 'failed') return NOTES.failed(s.reason)
    if (s.kind === 'starting') return NOTES.starting
    if (s.kind === 'up') return NOTES.up
    return NOTES.stopped
  }

  /** Starts the viewer; resolves with the first attempt's outcome. */
  start(): Promise<ViewerState> {
    this.stopped = false
    if (!this.attempt) this.attempt = this.run(this.options.savedPort ?? 0)
    return this.attempt
  }

  /** The state once the attempt in flight has settled (a start, or the restart after an
   *  exit), or the state now after `timeoutMs`; always the state as it stands, so a viewer
   *  that went down since its start is never answered as up. */
  async ready(timeoutMs: number): Promise<ViewerState> {
    if (!this.attempt) return this.current
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([this.attempt, late])
      return this.current
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Stops the child and every restart; the state is `stopped`. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    this.unguard()
    this.current = { kind: 'stopped' }
    // A backoff cut short: whoever waits on the restart is answered, and a later `start()`
    // is a fresh attempt rather than the promise of a restart that never comes.
    this.settleRestart?.(this.current)
    this.settleRestart = null
    this.attempt = null
    if (child) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve()
        child.on('exit', done)
        if (!child.kill('SIGTERM')) done()
        setTimeout(() => {
          child.kill('SIGKILL')
          done()
        }, 2_000).unref?.()
      })
    }
  }

  private async run(port: number): Promise<ViewerState> {
    this.current = { kind: 'starting' }
    // What to run, asked at every start: a copy installed since the last one is used now.
    let command: ViewerCommand | { missing: string }
    try {
      command = await this.options.command()
    } catch (error) {
      if (this.stopped) return this.current
      return this.failed(firstLine(error instanceof Error ? error.message : String(error)))
    }
    if (this.stopped) return this.current
    if ('missing' in command) {
      this.current = { kind: 'missing', note: command.missing }
      this.options.log?.('warn', command.missing)
      return this.current
    }
    const startedAt = this.now()
    const outcome = await new Promise<
      | { kind: 'up'; url: string; port: number; child: ChildLike }
      | { kind: 'failed'; reason: string; exited: boolean }
    >((resolve) => {
      let settled = false
      let stderr = ''
      let stdout = ''
      // Declared before `settle`: a spawn that throws settles before the timer is armed.
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (value: Parameters<typeof resolve>[0]): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      let child: ChildLike
      try {
        child = this.spawn(command.file, [...command.args, ...devArgs(this.options.root, port)], {
          env: command.env,
          // The input is a pipe this process holds open and never writes: when this process
          // ends, however it ends, the pipe closes and the preview host ends the child.
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        return settle({ kind: 'failed', reason: firstLine(String(error)), exited: true })
      }
      // Nothing is ever written on it: an error there (the child gone) is not this process's.
      child.stdin?.on('error', () => {})
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle({ kind: 'failed', reason: 'it did not answer within 20 seconds', exited: false })
      }, this.startTimeout)
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
        let at: number
        while ((at = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, at)
          stdout = stdout.slice(at + 1)
          const parsed = parseDevLine(line)
          if (parsed) settle({ kind: 'up', url: parsed.url, port: parsed.port, child })
        }
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      // The Node not found is a start that failed: the copy itself was looked for already.
      child.on('error', (error) => {
        settle({ kind: 'failed', reason: firstLine(error.message), exited: true })
      })
      child.on('exit', (code, signal) => {
        if (settled) return
        settle({
          kind: 'failed',
          reason:
            firstLine(stderr) ||
            `it exited with ${code === null ? (signal ?? '?') : `code ${code}`}`,
          exited: true
        })
      })
      // An exit after the viewer was up: noticed here too, once settled.
      child.on('exit', (code, signal) => {
        if (!settled || this.child !== child) return
        this.child = null
        this.unguard()
        if (this.stopped) return
        const ran = this.now() - startedAt
        this.failures = ran >= HEALTHY_MS ? 0 : this.failures + 1
        const wait = this.backoff[Math.min(this.failures, this.backoff.length - 1)] ?? 0
        this.options.log?.(
          'warn',
          `The Slideless viewer exited (${code === null ? (signal ?? '?') : `code ${code}`}); starting it again in ${wait} ms`
        )
        this.current = { kind: 'starting' }
        // The attempt in flight is the restart, from now: whoever waits on `ready()` during
        // the backoff gets the restart's outcome, never the dead viewer's `up`.
        let settle: (state: ViewerState) => void = () => {}
        this.attempt = new Promise<ViewerState>((resolve) => {
          settle = resolve
        })
        this.settleRestart = settle
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null
          this.settleRestart = null
          const run = this.run(this.savedOrAny())
          this.attempt = run
          void run.then(settle)
        }, wait)
      })
    })
    if (this.stopped) {
      if (outcome.kind === 'up') outcome.child.kill('SIGTERM')
      return this.current
    }
    if (outcome.kind === 'up') {
      this.child = outcome.child
      this.guardChild(outcome.child)
      this.current = { kind: 'up', url: outcome.url, port: outcome.port }
      if (outcome.port !== this.options.savedPort) {
        this.options.savedPort = outcome.port
        this.options.onPort?.(outcome.port)
      }
      this.options.log?.('info', `The Slideless viewer serves the decks at ${outcome.url}`)
      return this.current
    }
    // The saved port may be taken by now: once more on any port before giving up.
    if (port !== 0) {
      this.options.log?.(
        'warn',
        `The Slideless viewer could not take port ${port} (${outcome.reason}); any port`
      )
      return this.run(0)
    }
    return this.failed(outcome.reason)
  }

  /** No viewer: the start failed, and the footer says why. */
  private failed(reason: string): ViewerState {
    this.current = { kind: 'failed', reason }
    this.options.log?.('warn', NOTES.failed(reason))
    return this.current
  }

  private savedOrAny(): number {
    return this.options.savedPort ?? 0
  }
}
