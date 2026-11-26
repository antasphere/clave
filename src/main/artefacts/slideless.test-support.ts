/**
 * A Slideless command line that never runs (PRDCT-4266): a spawn that
 * records each call (the command, its arguments, its options) and hands the
 * test a fake child to drive, its input recorded, its output and errors
 * written by the test. For the tests of the accounts, the sign-in and the
 * links only; nothing here is a real process.
 */
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { ResolvedCli } from './slideless-cli'
import {
  runSlideless,
  startSlideless,
  type SlidelessRun,
  type SlidelessRunDeps,
  type SlidelessRunOptions
} from './slideless-run'

/** The Node the server runs the command line with, and its copy's script. */
export const EXEC_PATH = '/Applications/Clave.app/Contents/MacOS/Clave'
export const CLI_PATH = '/srv/clave-data/slideless/cli/0.15.0/bin.js'
/** The server's own environment: nothing of a login shell is ever added to it. */
export const SERVER_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/srv/home',
  CLAVE_SERVER: 'standalone'
}

/** A stream the code reads, written by the test. */
class FakeOutput extends EventEmitter {
  write(text: string): void {
    this.emit('data', Buffer.from(text))
  }
}

/** The input the code writes: every write recorded, and its end. */
class FakeInput extends EventEmitter {
  written = ''
  writes = 0
  ended = false
  write(chunk: string | Buffer): boolean {
    this.written += String(chunk)
    this.writes += 1
    return true
  }
  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk)
    this.ended = true
    return this
  }
}

export class FakeChild extends EventEmitter {
  readonly stdin = new FakeInput()
  readonly stdout = new FakeOutput()
  readonly stderr = new FakeOutput()
  readonly pid = 4242
  killedWith: string | null = null
  exited = false

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith = signal
    // The system ends it a moment later.
    queueMicrotask(() => this.exit(null, signal))
    return true
  }
  /** The command writes on stderr: a line, or a question with no end of line. */
  say(text: string): void {
    this.stderr.write(text)
  }
  /** The command writes on stdout. */
  print(text: string): void {
    this.stdout.write(text)
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

export interface FakeCall {
  readonly command: string
  /** The arguments after the copy's script. */
  readonly args: string[]
  readonly script: string
  readonly options: SpawnOptions
  readonly child: FakeChild
}

/** What the command does once started: given its arguments (after the script) and its child. */
export type Script = (args: string[], child: FakeChild) => void

/** An answer that prints `out`, says `err` and exits with `code`. */
export const answer =
  (out: string, code = 0, err = ''): ((child: FakeChild) => void) =>
  (child) => {
    if (out) child.print(out)
    if (err) child.say(err)
    child.exit(code)
  }

export interface FakeSlideless {
  readonly calls: FakeCall[]
  readonly deps: SlidelessRunDeps
  readonly run: (args: readonly string[], options: SlidelessRunOptions) => Promise<SlidelessRun>
  readonly start: (args: readonly string[]) => ChildProcess
  /** Every call's arguments after the script, in order. */
  readonly argv: () => string[][]
}

/**
 * Clave's copy, faked: each spawn is recorded and its script runs once the
 * caller has bound its listeners. `cli` answers what `resolveCli` would
 * (the refusal of a copy not ready, by throwing).
 */
export function fakeSlideless(
  script: Script = () => {},
  options: { readonly version?: string; readonly cli?: () => ResolvedCli } = {}
): FakeSlideless {
  const calls: FakeCall[] = []
  const spawn = (command: string, args: string[], spawnOptions: SpawnOptions): ChildProcess => {
    const child = new FakeChild()
    const call: FakeCall = {
      command,
      script: args[0]!,
      args: args.slice(1),
      options: spawnOptions,
      child
    }
    calls.push(call)
    queueMicrotask(() => script(call.args, child))
    return child as unknown as ChildProcess
  }
  const deps: SlidelessRunDeps = {
    execPath: EXEC_PATH,
    env: SERVER_ENV,
    spawn,
    cli:
      options.cli ??
      ((): ResolvedCli => ({
        cliPath: CLI_PATH,
        version: options.version ?? '0.15.0',
        override: false
      }))
  }
  return {
    calls,
    deps,
    run: (args, runOptions) => runSlideless(deps, args, runOptions),
    start: (args) => startSlideless(deps, args),
    argv: () => calls.map((call) => call.args)
  }
}

/** Lets every queued answer of the fakes run (microtasks only: fake timers stay still). */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

// ── A listing, as `profiles --json` prints it ──

export const DECKS = 'https://decks.example.test'
export const CLOUD = 'https://cloud.example.test'
export const LOCAL = 'http://127.0.0.1:3400'
export const HUB = 'https://hub.example.test'

export type ListedFix = { kind: string; argv: string[] } | null

/** A profile of the listing: signed in, or offering `fix`. */
export const listedProfile = (
  origin: string,
  fix: ListedFix = null,
  name = 'decks'
): Record<string, unknown> => ({
  name,
  default: name === 'decks',
  saved: true,
  site: {
    origin,
    name: 'Decks',
    hub: null,
    federated: false,
    cliVersion: '0.15.0',
    seenAt: '2026-11-25T10:00:00.000Z'
  },
  cliBehind: false,
  signIn: {
    state: fix ? 'needs_login' : 'signed_in',
    via: fix ? null : 'login',
    hub: null,
    email: fix ? null : 'someone@example.test',
    staleKeys: 0,
    fix
  },
  environment: []
})

/** What `profiles --json` prints for these profiles and hub logins. */
export const listingJson = (profiles: unknown[], logins: unknown[] = []): string =>
  JSON.stringify({
    machine: 'build-host',
    cliVersion: '0.15.0',
    defaultSite: DECKS,
    environment: { url: null, key: false, hubUrl: null },
    logins,
    profiles
  })

/** Whether a call is the listing (`--json profiles`, checked or not). */
export const isListing = (args: string[]): boolean =>
  args[0] === '--json' && args[1] === 'profiles' && (args.length === 2 || args[2] === '--check')
