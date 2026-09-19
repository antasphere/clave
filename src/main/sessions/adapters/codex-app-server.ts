import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolvePosixShellLaunch } from '../../shell-launch'

export type RpcId = number | string
export interface RpcNotification {
  method: string
  params?: unknown
}
export interface RpcRequest extends RpcNotification {
  id: RpcId
}
export interface CodexConnection {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): void
  respond(id: RpcId, result: unknown): void
  reject(id: RpcId, message: string): void
  close(): Promise<void>
}
export interface CodexCallbacks {
  notification(frame: RpcNotification): void
  request(frame: RpcRequest): void
  error(error: Error): void
  exit(code: number, stderr?: string): void
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Codex's stdio protocol is newline-delimited JSON-RPC (without the jsonrpc field).
 * Request ids are independent in the two directions. Never log raw frames: they
 * can contain private source, tool arguments, or authentication challenges. */
export class CodexAppServer implements CodexConnection {
  private nextId = 0
  private pending = new Map<
    RpcId,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private incoming = new Set<RpcId>()
  private buffer = ''
  private stderrTail = Buffer.alloc(0)
  private closed = false
  private stopping = false
  private stopPromise?: Promise<void>
  private ended: Promise<void>
  private resolveEnded!: () => void

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private callbacks: CodexCallbacks,
    private timeoutMs = 30_000
  ) {
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => this.read(data))
    // Keep only the diagnostic tail; never forward unbounded provider logs.
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, chunk.subarray(-4096)]).subarray(-4096)
    })
    child.stderr.on('error', (error) => this.fail(error))
    child.on('error', (error) => this.fail(error))
    child.stdin.on('error', (error) => {
      if (!this.stopping) this.fail(error)
    })
    child.stdout.on('error', (error) => this.fail(error))
    child.on('close', (code) => {
      if (this.buffer.trim() && !this.stopping)
        this.callbacks.error(new Error('Codex closed with an incomplete JSON-RPC frame'))
      this.closed = true
      this.rejectPending(new Error('Codex app-server disconnected'))
      this.incoming.clear()
      this.resolveEnded()
      this.callbacks.exit(code ?? 1, this.stderrTail.toString('utf8'))
    })
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || this.stopping) return Promise.reject(new Error('Codex app-server is closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  notify(method: string, params?: unknown): void {
    this.send({ method, params })
  }
  respond(id: RpcId, result: unknown): void {
    if (!this.incoming.has(id)) throw new Error(`Unknown Codex server request: ${id}`)
    this.send({ id, result })
    this.incoming.delete(id)
  }
  reject(id: RpcId, message: string): void {
    if (!this.incoming.has(id)) throw new Error(`Unknown Codex server request: ${id}`)
    this.send({ id, error: { code: -32601, message } })
    this.incoming.delete(id)
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.rejectPending(new Error('Codex app-server closed'))
    this.child.stdin.end()
    this.child.kill()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000)
    timer.unref()
    this.stopPromise = this.ended.finally(() => clearTimeout(timer))
    return this.stopPromise
  }
  private send(frame: unknown): void {
    if (this.closed || this.stopping) throw new Error('Codex app-server is closed')
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }
  private fail(error: Error): void {
    if (this.stopping || this.closed) return
    this.callbacks.error(error)
    void this.close()
  }
  private read(data: string): void {
    if (this.stopping || this.closed) return
    this.buffer += data
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      if (line.length > 16 * 1024 * 1024) {
        this.fail(new Error('Codex JSON-RPC frame exceeds 16 MiB'))
        return
      }
      let frame: Record<string, unknown>
      try {
        frame = object(JSON.parse(line))
      } catch {
        this.fail(new Error('Invalid Codex JSON-RPC JSON'))
        return
      }
      const id = frame.id
      const hasId = typeof id === 'string' || typeof id === 'number'
      if (typeof frame.method === 'string') {
        if (hasId) {
          if (this.incoming.has(id)) {
            this.fail(new Error('Duplicate Codex server request id'))
            return
          }
          this.incoming.add(id)
          this.callbacks.request({ ...frame, id, method: frame.method, params: frame.params })
        } else this.callbacks.notification({ ...frame, method: frame.method, params: frame.params })
      } else if (hasId && ('result' in frame || 'error' in frame)) {
        const pending = this.pending.get(id)
        if (!pending) continue // A late response to a timed-out request.
        this.pending.delete(id)
        clearTimeout(pending.timer)
        if ('error' in frame)
          pending.reject(new Error(String(object(frame.error).message ?? 'Codex protocol error')))
        else pending.resolve(frame.result)
      } else {
        this.fail(new Error('Invalid Codex JSON-RPC frame'))
        return
      }
    }
    if (this.buffer.length > 16 * 1024 * 1024)
      this.fail(new Error('Codex JSON-RPC frame exceeds 16 MiB'))
  }
}

export function spawnCodexAppServer(cwd: string, callbacks: CodexCallbacks): CodexConnection {
  const launch =
    process.platform === 'win32'
      ? { file: 'codex.cmd', args: ['app-server'] }
      : resolvePosixShellLaunch(process.env.SHELL || '/bin/zsh', 'exec codex app-server')
  return new CodexAppServer(
    spawn(launch.file, launch.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32'
    }),
    callbacks
  )
}
