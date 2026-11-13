import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:os'
import { NdjsonLines } from './ndjson'

/**
 * The Agent Client Protocol's transport (version 1): newline-delimited
 * JSON-RPC 2.0 over an agent's stdin and stdout, every frame carrying
 * `"jsonrpc":"2.0"` (which Codex's app-server frames do not, so this is a
 * client of its own rather than `codex-app-server.ts`). Request ids are
 * independent in the two directions. Never log a frame: it can hold private
 * source, tool arguments, or an authentication challenge.
 */

export type RpcId = number | string
export interface RpcNotification {
  method: string
  params?: unknown
}
export interface RpcRequest extends RpcNotification {
  id: RpcId
}
export interface AcpCallbacks {
  notification(frame: RpcNotification): void
  request(frame: RpcRequest): void
  error(error: Error): void
  exit(code: number, stderrTail?: string): void
}
export interface AcpRequestOptions {
  /** Milliseconds before the request fails; null waits for as long as it
   *  takes (a `session/prompt` runs for minutes). Absent: the default. */
  timeout?: number | null
}
/** The JSON-RPC answer to a method the client does not offer. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601

/** The agent's refusal, distinct from a timeout or a lost connection. */
export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpRpcError'
  }
}

const STDERR_TAIL_BYTES = 4096
const KILL_GRACE_MS = 3000

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export class AcpConnection {
  private nextId = 0
  private pending = new Map<
    RpcId,
    {
      method: string
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
  /** Lines read that were not JSON, or JSON but not a JSON-RPC 2.0 frame. */
  ignoredLines = 0

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly callbacks: AcpCallbacks,
    private readonly timeoutMs = 30_000,
    private readonly secrets: readonly string[] = []
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
      this.rejectPending(new Error(`The agent exited with code ${exitCode}`))
      this.resolveEnded()
      this.callbacks.exit(exitCode, this.redact(this.stderrTail.toString('utf8')))
    })
  }

  get closed(): boolean {
    return this.exited || this.stopping !== undefined
  }

  request(method: string, params?: unknown, options: AcpRequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The agent connection is closed'))
    const id = ++this.nextId
    const timeout = options.timeout === undefined ? this.timeoutMs : options.timeout
    return new Promise((resolve, reject) => {
      const timer =
        timeout === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`The agent did not answer ${method} in time`))
            }, timeout)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
      } catch (error) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }
  respond(id: RpcId, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result: result ?? null })
  }
  reject(id: RpcId, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }
  /** Stdin ended, SIGTERM, SIGKILL after three seconds; resolved once the
   *  child has exited. Every pending request is refused at once. */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve()
    if (this.stopping) return this.stopping
    this.rejectPending(new Error('The agent connection was closed'))
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

  private send(frame: Record<string, unknown>): void {
    if (this.closed) throw new Error('The agent connection is closed')
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  private redact(value: string): string {
    for (const secret of this.secrets) if (secret) value = value.split(secret).join('[redacted]')
    return value
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
    const frame = object(parsed)
    if (frame.jsonrpc !== '2.0') {
      this.ignoredLines++
      return
    }
    const id = frame.id
    const hasId = typeof id === 'string' || typeof id === 'number'
    if (typeof frame.method === 'string') {
      if (hasId) this.callbacks.request({ id, method: frame.method, params: frame.params })
      else this.callbacks.notification({ method: frame.method, params: frame.params })
      return
    }
    if (hasId && ('result' in frame || 'error' in frame)) {
      const pending = this.pending.get(id)
      if (!pending) return // Unknown, or a late answer to a request that timed out.
      this.pending.delete(id)
      if (pending.timer) clearTimeout(pending.timer)
      if ('error' in frame) {
        const error = object(frame.error)
        const message =
          typeof error.message === 'string' && error.message
            ? error.message
            : `The agent refused ${pending.method}`
        pending.reject(
          typeof error.code === 'number'
            ? new AcpRpcError(error.code, message, error.data)
            : new Error(message)
        )
      } else pending.resolve(frame.result)
      return
    }
    this.ignoredLines++
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 0
}
