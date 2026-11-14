import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:os'
import { NdjsonLines } from './ndjson'
import { STDERR_TAIL_BYTES } from './start-refusal'

/**
 * Pi's rpc transport (`pi --mode rpc`, Pi 1.5): strict JSONL on the child's
 * stdin and stdout, split on LF only (never Node's `readline`, which also
 * splits on U+2028/U+2029, legal inside a JSON string). A command is
 * `{ id, type, ...params }`; its answer is a `response` frame carrying the same
 * id. Everything else on stdout is an event, with no id, arriving between the
 * responses in any order. Never log a frame: it can hold private source, tool
 * arguments or a provider's error text.
 */

/** One parsed stdout record that is not the answer to a pending command. */
export type PiRpcEvent = Record<string, unknown> & { type: string }

export interface PiRpcCallbacks {
  event(frame: PiRpcEvent): void
  error(error: Error): void
  exit(code: number, stderrTail?: string): void
}
export interface PiRpcCommandOptions {
  /** Milliseconds before the command fails; null waits for as long as it
   *  takes (an `abort` answers only once Pi is idle). Absent: the default. */
  timeout?: number | null
}

/** Pi's refusal of a command (`success: false`), distinct from a timeout or a
 *  lost connection. */
export class PiRpcError extends Error {
  constructor(
    message: string,
    readonly command?: string
  ) {
    super(message)
    this.name = 'PiRpcError'
  }
}

const KILL_GRACE_MS = 3000

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export class PiRpcConnection {
  private nextId = 0
  private pending = new Map<
    string,
    {
      type: string
      resolve(value: unknown): void
      reject(error: Error): void
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  private lines: NdjsonLines
  private stderrTail = Buffer.alloc(0)
  private exited = false
  private stopping?: Promise<void>
  private ended: Promise<void>
  private resolveEnded!: () => void
  /** Lines read that were not a JSON object with a string `type`. */
  ignoredLines = 0

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly callbacks: PiRpcCallbacks,
    private readonly timeoutMs = 30_000
  ) {
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve
    })
    this.lines = new NdjsonLines((line) => this.read(line))
    child.stdout.on('data', (chunk: Buffer | string) =>
      this.lines.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    )
    child.stdout.on('end', () => this.lines.end())
    // Only the diagnostic tail is kept, and it is never logged.
    child.stderr.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      this.stderrTail = Buffer.concat([
        this.stderrTail,
        bytes.subarray(-STDERR_TAIL_BYTES)
      ]).subarray(-STDERR_TAIL_BYTES)
    })
    const fail = (error: Error): void => {
      if (!this.exited && !this.stopping) this.callbacks.error(error)
    }
    child.on('error', fail)
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.stdin.on('error', fail)
    child.on('close', (code, signal) => {
      this.exited = true
      const exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1)
      this.rejectPending(new Error(`Pi exited with code ${exitCode}`))
      this.resolveEnded()
      this.callbacks.exit(exitCode, this.stderrTail.toString('utf8'))
    })
  }

  get closed(): boolean {
    return this.exited || this.stopping !== undefined
  }

  /** Send one command and wait for its `response`: `data` on success (undefined
   *  when Pi returns none), a `PiRpcError` carrying Pi's word on refusal. */
  command(
    type: string,
    params?: Record<string, unknown>,
    options: PiRpcCommandOptions = {}
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The Pi connection is closed'))
    const id = `c${++this.nextId}`
    const timeout = options.timeout === undefined ? this.timeoutMs : options.timeout
    return new Promise((resolve, reject) => {
      const timer =
        timeout === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`Pi did not answer ${type} in time`))
            }, timeout)
      this.pending.set(id, { type, resolve, reject, timer })
      try {
        // The id and the type lead the frame, and no param overrides them.
        this.write(Object.assign({ id, type }, params, { id, type }))
      } catch (error) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** A frame Pi answers with nothing (`extension_ui_response`). */
  send(frame: Record<string, unknown>): void {
    this.write(frame)
  }

  /** Stdin ended, SIGTERM, SIGKILL after three seconds; resolved once the
   *  child has exited. Every pending command is refused at once. */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve()
    if (this.stopping) return this.stopping
    this.rejectPending(new Error('The Pi connection was closed'))
    try {
      this.child.stdin.end()
    } catch {
      // A stdin already destroyed: the signals below still apply.
    }
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    this.stopping = this.ended.finally(() => clearTimeout(timer))
    return this.stopping
  }

  private write(frame: Record<string, unknown>): void {
    if (this.closed) throw new Error('The Pi connection is closed')
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
  private read(line: string): void {
    if (this.closed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.ignoredLines++
      return
    }
    const frame = record(parsed)
    if (typeof frame.type !== 'string') {
      this.ignoredLines++
      return
    }
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id)
      if (pending) {
        this.pending.delete(frame.id)
        if (pending.timer) clearTimeout(pending.timer)
        if (frame.success === true) pending.resolve(frame.data)
        else
          pending.reject(
            new PiRpcError(
              typeof frame.error === 'string' && frame.error
                ? frame.error
                : `Pi refused ${pending.type}`,
              pending.type
            )
          )
        return
      }
    }
    // An event, or a response to no pending command (the `parse` failure has
    // no id; a late answer to a command that timed out): the caller sees it.
    this.callbacks.event(frame as PiRpcEvent)
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 0
}
