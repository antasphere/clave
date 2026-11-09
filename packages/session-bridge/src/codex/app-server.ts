/**
 * A tiny client of `codex app-server`: newline-delimited JSON-RPC over stdio
 * (no `jsonrpc` field), request ids independent in the two directions. Enough
 * to `initialize`, `thread/resume` and read a thread back, which is how the
 * writer's work is proven: through the real Codex, on a Codex home of its
 * own. Nothing here logs a raw frame: frames can carry private source.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface AppServerOptions {
  /** The Codex home the server reads; never the machine's own in a test. */
  codexHome: string
  /** The working directory the server starts in. */
  cwd?: string
  bin?: string
  timeoutMs?: number
}

export interface Notification {
  method: string
  params?: unknown
}

export class CodexRpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'CodexRpcError'
    this.code = code
  }
}

export class CodexAppServer {
  readonly notifications: Notification[] = []
  private nextId = 0
  private buffer = ''
  private closed = false
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >()
  private stderr = ''
  private readonly ended: Promise<number>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly timeoutMs: number

  private constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child
    this.timeoutMs = timeoutMs
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => this.read(data))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => {
      this.stderr = (this.stderr + data).slice(-4096)
    })
    this.ended = new Promise((resolve) => {
      // A spawn that fails (no such executable, no such cwd) emits `error` and
      // never `close`: settle every caller with the reason instead of a timeout.
      child.on('error', (error) => {
        this.closed = true
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error(`Codex app-server could not start: ${error.message}`))
        }
        this.pending.clear()
        resolve(1)
      })
      child.on('close', (code) => {
        this.closed = true
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(
            new Error(`Codex app-server exited (${code ?? 'signal'}): ${this.stderr.trim()}`)
          )
        }
        this.pending.clear()
        resolve(code ?? 1)
      })
    })
  }

  /** Spawn the server and complete the `initialize` handshake. */
  static async start(options: AppServerOptions): Promise<CodexAppServer> {
    const child = spawn(options.bin ?? 'codex', ['app-server'], {
      cwd: options.cwd,
      env: { ...process.env, CODEX_HOME: options.codexHome },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const server = new CodexAppServer(child, options.timeoutMs ?? 30_000)
    await server.request('initialize', {
      clientInfo: { name: 'session_bridge', title: 'session-bridge', version: '0.1.0' }
    })
    server.notify('initialized')
    return server
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex request timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`)
  }
  async close(): Promise<number> {
    if (this.closed) return this.ended
    this.child.stdin.end()
    this.child.kill()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000)
    timer.unref()
    return this.ended.finally(() => clearTimeout(timer))
  }

  private read(data: string): void {
    this.buffer += data
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof frame.method === 'string') {
        // A server request (an approval) would carry an id; none is expected
        // from a resume, and one left unanswered times out on Codex's side.
        this.notifications.push({ method: frame.method, params: frame.params })
        continue
      }
      const id = frame.id
      if (typeof id !== 'number') continue
      const pending = this.pending.get(id)
      if (!pending) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if ('error' in frame) {
        const error = (frame.error ?? {}) as Record<string, unknown>
        pending.reject(
          new CodexRpcError(
            typeof error.code === 'number' ? error.code : 0,
            String(error.message ?? 'Codex protocol error')
          )
        )
      } else pending.resolve(frame.result)
    }
  }
}

/** One turn of a thread as `thread/resume` returns it. */
export interface ResumedTurn {
  id: string
  status: string
  items: Record<string, unknown>[]
}
export interface ResumedThread {
  id: string
  historyMode: string
  model: string | null
  cwd: string
  preview: string
  turns: ResumedTurn[]
}

function threadOf(result: unknown): ResumedThread {
  const thread = ((result as Record<string, unknown>).thread ?? {}) as Record<string, unknown>
  const turns = Array.isArray(thread.turns) ? (thread.turns as Record<string, unknown>[]) : []
  return {
    id: String(thread.id ?? ''),
    historyMode: String(thread.historyMode ?? ''),
    model: typeof thread.model === 'string' ? thread.model : null,
    cwd: String(thread.cwd ?? ''),
    preview: String(thread.preview ?? ''),
    turns: turns.map((turn) => ({
      id: String(turn.id ?? ''),
      status: String(turn.status ?? ''),
      items: Array.isArray(turn.items) ? (turn.items as Record<string, unknown>[]) : []
    }))
  }
}

/** Resume a thread through the real Codex on the given home and read its
 *  turns back; the server is closed before this returns. A resume is what a
 *  person's `codex resume` does, and it writes: Codex appends its settings to
 *  the file and, given a `cwd`, keeps it as the thread's from then on; leave
 *  `cwd` unset to keep the thread's own. */
export async function resumeThread(
  threadId: string,
  options: AppServerOptions
): Promise<ResumedThread> {
  const server = await CodexAppServer.start(options)
  try {
    return threadOf(
      await server.request('thread/resume', {
        threadId,
        ...(options.cwd ? { cwd: options.cwd } : {})
      })
    )
  } finally {
    await server.close()
  }
}

/** Read a thread with its turns through the real Codex without resuming it:
 *  nothing is appended to the file and its cwd stays as written. */
export async function readThread(
  threadId: string,
  options: AppServerOptions
): Promise<ResumedThread> {
  const server = await CodexAppServer.start(options)
  try {
    return threadOf(await server.request('thread/read', { threadId, includeTurns: true }))
  } finally {
    await server.close()
  }
}

/** A thread with its turns, read without a resume when Codex has already
 *  loaded it once, and resumed once otherwise: `thread/read` answers no turns
 *  for a thread Codex never projected (a file just written, or copied in),
 *  and only a resume projects it. The resume sends no `cwd`, so the thread
 *  keeps its own; Codex appends its settings row to the file, as the person's
 *  own `codex resume` does. `loaded` says which road was taken. */
export async function loadThread(
  threadId: string,
  options: AppServerOptions & { readOnly?: boolean }
): Promise<ResumedThread & { loaded: 'read' | 'resumed' }> {
  const read = await readThread(threadId, options)
  if (read.turns.length || options.readOnly) return { ...read, loaded: 'read' }
  const { cwd: _cwd, ...rest } = options
  void _cwd
  return { ...(await resumeThread(threadId, rest)), loaded: 'resumed' }
}
