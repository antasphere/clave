/**
 * Clave's own copy of the Slideless command line, run once (PRDCT-4266): the
 * accounts of the machine and the links of an artefact are each a run of
 * it. Electron's Node (`execPath`) runs the copy's `bin.js` with
 * `ELECTRON_RUN_AS_NODE`, in the server's own environment, never the login
 * shell's, and never a `slideless` found on a path. Every stream is a pipe:
 * a secret (a key, a password) is written on the input and the input closed;
 * with nothing to write the input is closed at once, so the command never
 * waits on it. What it prints is kept to its tail (64 KB of output, 8 KB of
 * errors), and a run past its time is killed.
 *
 * Nothing here is logged: not the arguments, not the input. The e-mail code
 * sign-in, which answers a question the command asks mid-run, starts the
 * same command with `startSlideless` and holds its input itself
 * (`slideless-sign-in.ts`).
 */
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { ResolvedCli } from './slideless-cli'
import { firstLine } from './slideless-json'

/** The output kept of a run: its last 64 KB. */
export const STDOUT_LIMIT = 64 * 1024
/** The errors kept of a run: their last 8 KB. */
export const STDERR_LIMIT = 8 * 1024

export interface SlidelessRunDeps {
  /** The Node that runs the command line (the app's binary as Node, or the one named). */
  readonly execPath: string
  /** The server's own environment. */
  readonly env: NodeJS.ProcessEnv
  readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /** Clave's own copy when it is ready to run; throws the refusal that says why not. */
  readonly cli: () => ResolvedCli
}

export interface SlidelessRunOptions {
  readonly cwd?: string
  /** Written on the input, which is then closed. */
  readonly input?: string
  readonly timeoutMs: number
}

export interface SlidelessRun {
  /** The exit code; null when a signal ended the run. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Killed at its time. */
  readonly timedOut: boolean
}

/** Clave's own copy started with `args`, every stream a pipe, its input left
 *  open for the caller. Throws the refusal when the copy is not ready. */
export function startSlideless(
  deps: SlidelessRunDeps,
  args: readonly string[],
  options: { readonly cwd?: string } = {}
): ChildProcess {
  const { cliPath } = deps.cli()
  return (deps.spawn ?? spawnChild)(deps.execPath, [cliPath, ...args], {
    env: { ...deps.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(options.cwd !== undefined && { cwd: options.cwd })
  })
}

/** Why a run failed, in the command's words: its first error line, or what ended it. */
export function runFailure(run: SlidelessRun): string {
  if (run.timedOut) return 'Slideless did not answer in time.'
  return firstLine(run.stderr) || `Slideless stopped with exit code ${run.code ?? 'none'}.`
}

/** A sentence with a secret the person gave (a key, a code, a password)
 *  taken out, should the command ever repeat it. Shorter than four
 *  characters, it is not looked for: it would hide ordinary words. */
export function withoutSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < 4 || !text.includes(secret)) return text
  return text.split(secret).join('[hidden]')
}

/** The last `limit` bytes of a stream. */
class Tail {
  private kept = Buffer.alloc(0)
  constructor(private readonly limit: number) {}
  add(chunk: Buffer | string): void {
    const next = Buffer.concat([this.kept, Buffer.from(chunk)])
    this.kept = next.length > this.limit ? next.subarray(next.length - this.limit) : next
  }
  text(): string {
    return this.kept.toString('utf8')
  }
}

/** One run of Clave's own copy, to its end or its time. Rejects only with the
 *  refusal of a copy that is not ready; a command that fails is a run with
 *  its code and what it printed. */
export async function runSlideless(
  deps: SlidelessRunDeps,
  args: readonly string[],
  options: SlidelessRunOptions
): Promise<SlidelessRun> {
  const child = startSlideless(deps, args, options.cwd === undefined ? {} : { cwd: options.cwd })
  return new Promise((resolve) => {
    const out = new Tail(STDOUT_LIMIT)
    const err = new Tail(STDERR_LIMIT)
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: out.text(), stderr: err.text(), timedOut })
    }
    child.stdout?.on('data', (chunk: Buffer) => out.add(chunk))
    child.stderr?.on('data', (chunk: Buffer) => err.add(chunk))
    // A command that exits before it reads its input fails the write, not the run.
    child.stdin?.on('error', () => {})
    if (options.input === undefined) child.stdin?.end()
    else child.stdin?.end(options.input)
    // A child that could not start: its reason, never the arguments it was given.
    child.once('error', (error) => {
      err.add(`${error.message}\n`)
      finish(null)
    })
    child.once('close', (code: number | null) => finish(code))
  })
}
