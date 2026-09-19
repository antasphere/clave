import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { AdapterLaunch } from '../adapter'

export type Frame = Record<string, unknown>
export const MAX_FRAME = 4 * 1024 * 1024
/** Only fixed, adapter-authored text may cross the daemon's error boundary. */
export class AdapterError extends Error {
  readonly safeMessage: string
  constructor(message: string) {
    super(message)
    this.name = 'AdapterError'
    this.safeMessage = message
  }
}
export function object(value: unknown): Frame {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid provider object')
  return value as Frame
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid provider string')
  return value
}
export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid provider array')
  return value
}
export function identifier(value: unknown): string {
  const id = string(value)
  if (!id || id.length > 1024) throw new Error('Invalid provider identifier')
  return id
}
export function printable(value: unknown): string {
  return (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).slice(0, 32_768)
}

/** Byte budget applies before decoding; no partial UTF-8 codepoints are lost. */
export class JsonLines {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private bytes = 0
  constructor(
    private receive: (frame: Frame) => void,
    private limit = MAX_FRAME
  ) {}
  push(chunk: Buffer): void {
    // Split bytes, rather than decoding a potentially unbounded chunk first.
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      this.bytes += part.length
      if (this.bytes > this.limit) throw new Error('Provider frame exceeds limit')
      this.buffer += this.decoder.write(part)
      if (newline < 0) return
      this.buffer += this.decoder.end()
      const line = this.buffer.trim()
      this.buffer = ''
      this.bytes = 0
      this.decoder = new StringDecoder('utf8')
      if (line) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          throw new Error('Malformed provider JSON')
        }
        this.receive(object(parsed))
      }
      offset = end + 1
    }
  }
  end(): void {
    if ((this.buffer + this.decoder.end()).trim()) throw new Error('Truncated provider frame')
  }
}

export function validateArgs(launch: AdapterLaunch, forbidden: string[]): void {
  if (!launch.command.length || !launch.command[0])
    throw new AdapterError('Missing provider command')
  // command may contain an executable wrapper and its arguments. Every argument
  // is preserved, but managed protocol overrides anywhere in the argv are refused.
  for (const arg of [...launch.command.slice(1), ...launch.additionalArgs]) {
    if (arg.includes('\0') || forbidden.includes(arg.split('=')[0]) || arg === '--')
      throw new AdapterError('Launch flag conflicts with the managed conversation protocol')
  }
}

/** Owns one process group, never a user's pre-existing CLI or daemon. */
export class OwnedProcess {
  private child?: ChildProcessWithoutNullStreams
  private closing?: Promise<void>
  private stopped = false
  private closed = false
  private stderrBytes = 0
  constructor(private failure: (reason: string) => void) {}
  start(
    launch: AdapterLaunch,
    args: string[],
    receive: (chunk: Buffer) => void,
    end = (): void => {}
  ): void {
    if (this.child) throw new Error('Provider already started')
    this.child = spawn(
      launch.command[0],
      [...launch.command.slice(1), ...launch.additionalArgs, ...args],
      {
        cwd: launch.options.cwd,
        env: launch.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    const child = this.child
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.stopped) return
      try {
        receive(chunk)
      } catch {
        this.failure('Invalid or unsupported provider protocol frame')
      }
    })
    // Do not persist/forward arbitrary stderr: provider errors can contain credentials.
    // Drain it with constant memory, keeping only an aggregate diagnostic.
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes = Math.min(1_000_000, this.stderrBytes + chunk.length)
    })
    child.stdin.on('error', () => {
      if (!this.stopped) this.failure('Provider input closed')
    })
    child.on('error', () => {
      if (!this.stopped) this.failure('Unable to start provider executable')
    })
    child.on('close', (code) => {
      this.closed = true
      if (this.stopped) return
      try {
        end()
      } catch {
        this.failure('Truncated provider frame')
      }
      this.failure(
        `Provider exited (${code ?? 'signal'}${this.stderrBytes ? '; diagnostics withheld' : ''})`
      )
    })
  }
  write(frame: unknown): Promise<void> {
    const wire = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(wire) > MAX_FRAME)
      return Promise.reject(new Error('Provider input exceeds limit'))
    if (!this.child || this.stopped || this.closed)
      return Promise.reject(new Error('Provider is not running'))
    if (this.child.stdin.writableLength > MAX_FRAME)
      return Promise.reject(new Error('Provider input is congested'))
    return new Promise((resolve, reject) => {
      this.child!.stdin.write(wire, (error) =>
        error ? reject(new Error('Provider input closed')) : resolve()
      )
    })
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    const child = this.child
    if (!child?.pid) return Promise.resolve()
    const signal = (force: boolean): void => {
      try {
        if (process.platform === 'win32') {
          // taskkill is restricted to the exact owned PID and its descendants.
          const killer = spawn(
            'taskkill',
            ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
            { windowsHide: true, stdio: 'ignore' }
          )
          killer.on('error', () => {
            child.kill(force ? 'SIGKILL' : 'SIGTERM')
          })
        } else process.kill(-child.pid!, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* Group already exited. */
      }
    }
    this.closing = new Promise((resolve) => {
      signal(false)
      // Kill the group even if the immediate child exits before its descendants.
      setTimeout(() => {
        signal(true)
        resolve()
      }, 500)
    })
    return this.closing
  }
}

type Pending = {
  resolve: (value: Frame) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}
export class Requests {
  private sequence = 0
  private pending = new Map<string, Pending>()
  async call(send: (id: string) => Promise<void>, timeout = 30_000): Promise<Frame> {
    if (this.pending.size >= 64) throw new Error('Too many provider requests')
    const id = `clave-${++this.sequence}`
    return new Promise<Frame>((resolve, reject) => {
      const timer =
        timeout === 0
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(new Error('Provider request timed out'))
            }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      void send(id).catch(() => this.settle(id, undefined, true))
    })
  }
  settle(id: unknown, result?: unknown, failed = false): boolean {
    const key = String(id)
    const request = this.pending.get(key)
    if (!request) return false
    this.pending.delete(key)
    clearTimeout(request.timer)
    if (failed) request.reject(new Error('Provider rejected the request'))
    else {
      try {
        request.resolve(result === undefined || result === null ? {} : object(result))
      } catch {
        request.reject(new Error('Invalid provider response'))
      }
    }
    return true
  }
  close(): void {
    for (const id of this.pending.keys()) this.settle(id, undefined, true)
  }
}
