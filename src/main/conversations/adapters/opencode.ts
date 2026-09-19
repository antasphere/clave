import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { BaseAdapter } from './base'
import {
  MAX_FRAME,
  identifier,
  list,
  object,
  printable,
  string,
  validateArgs,
  type Frame
} from './transport'

/** SSE with bounded event and line buffers. Handles CRLF and split UTF-8. */
export class ServerEvents {
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  private data: string[] = []
  private size = 0
  constructor(private receive: (frame: Frame) => void) {}
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.write(Buffer.from(chunk))
    if (Buffer.byteLength(this.buffer) > MAX_FRAME) throw new Error('SSE line too large')
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) {
        if (this.data.length) this.receive(object(JSON.parse(this.data.join('\n'))))
        this.data = []
        this.size = 0
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '')
        this.size += Buffer.byteLength(data) + 1
        if (this.size > MAX_FRAME) throw new Error('SSE event too large')
        this.data.push(data)
      }
    }
  }
}

export class OpenCodeAdapter extends BaseAdapter {
  readonly capabilities = { permissions: true, questions: true, resume: true }
  private base = ''
  private password = randomBytes(32).toString('hex')
  private lifetime = new AbortController()
  private roles = new Map<string, string>()
  private questionIds = new Map<string, string[]>()
  protected async boot(): Promise<void> {
    validateArgs(this.launch, [
      '--port',
      '--hostname',
      '--mdns',
      '--mdns-domain',
      '--cors',
      '--attach'
    ])
    const env = {
      ...this.launch.env,
      OPENCODE_SERVER_PASSWORD: this.password,
      OPENCODE_SERVER_USERNAME: 'clave'
    }
    let announce = ''
    let connected = false
    // We only trust an authenticated health response at the port announced by
    // our child. Never scan for or reuse an existing user's server.
    const announced = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCode readiness timed out')), 15_000)
      const decoder = new StringDecoder('utf8')
      this.process.start(
        { ...this.launch, env },
        ['serve', '--hostname', '127.0.0.1', '--port', '0'],
        (chunk) => {
          if (connected) return
          announce += decoder.write(chunk)
          if (announce.length > 65_536) {
            clearTimeout(timer)
            reject(new Error('Invalid OpenCode startup output'))
            return
          }
          const match = announce.match(/http:\/\/127\.0\.0\.1:(\d+)/)
          if (match) {
            const port = Number(match[1])
            if (port < 1 || port > 65535) {
              clearTimeout(timer)
              reject(new Error('Invalid server port'))
              return
            }
            connected = true
            clearTimeout(timer)
            resolve(`http://127.0.0.1:${port}`)
          }
        }
      )
    })
    this.base = await announced
    const health = object(await this.http('/global/health'))
    if (health.healthy !== true || typeof health.version !== 'string')
      throw new Error('Unsupported OpenCode health protocol')
    await this.subscribe()
    const resume = this.launch.providerSessionId ?? this.launch.options.resumeSessionId
    const permission = [
      { permission: '*', pattern: '*', action: this.launch.options.dangerousMode ? 'allow' : 'ask' }
    ]
    let session: Frame
    if (resume) {
      session = object(await this.http(`/session/${encodeURIComponent(resume)}`))
      // Session-scoped rule takes precedence over config and persists on resume.
      await this.http(`/session/${encodeURIComponent(resume)}`, 'PATCH', { permission })
    } else session = object(await this.http('/session', 'POST', { permission }))
    this.providerSession(identifier(session.id))
  }
  private url(path: string): string {
    return `${this.base}${path}?directory=${encodeURIComponent(this.launch.options.cwd)}`
  }
  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`clave:${this.password}`).toString('base64')}`,
      'Content-Type': 'application/json'
    }
  }
  private async http(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(this.url(path), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]),
      redirect: 'error'
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`OpenCode HTTP ${response.status}`)
    }
    if (response.status === 204) return {}
    const reader = response.body?.getReader()
    if (!reader) return {}
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > MAX_FRAME) throw new Error('OpenCode response exceeds limit')
        chunks.push(next.value)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? JSON.parse(text) : {}
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
  private async subscribe(): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    try {
      response = await fetch(this.url('/event'), {
        headers: this.headers(),
        signal: AbortSignal.any([this.lifetime.signal, controller.signal]),
        redirect: 'error'
      })
    } finally {
      clearTimeout(timer)
    }
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      await response.body?.cancel()
      throw new Error('OpenCode SSE unavailable')
    }
    const reader = response.body.getReader()
    const parser = new ServerEvents((frame) => this.receive(frame))
    // A dropped stream is fatal: reconnect without replay would lose approvals
    // and deltas, falsely presenting an up-to-date conversation.
    void (async () => {
      try {
        while (!this.dead) {
          const next = await reader.read()
          if (next.done) throw new Error('SSE ended')
          parser.push(next.value)
        }
      } catch {
        if (!this.dead) this.fail('OpenCode event stream disconnected or invalid')
      } finally {
        await reader.cancel().catch(() => {})
      }
    })()
  }
  protected async prompt(text: string): Promise<void> {
    this.roles.clear()
    let model: Frame | undefined
    if (this.launch.options.model) {
      const slash = this.launch.options.model.indexOf('/')
      if (slash < 1) throw new Error('OpenCode models must be provider/model')
      model = {
        providerID: this.launch.options.model.slice(0, slash),
        modelID: this.launch.options.model.slice(slash + 1)
      }
    }
    await this.http(`/session/${encodeURIComponent(this.sessionId!)}/prompt_async`, 'POST', {
      parts: [{ type: 'text', text }],
      ...(model ? { model } : {})
    })
  }
  protected async abort(): Promise<void> {
    await this.http(`/session/${encodeURIComponent(this.sessionId!)}/abort`, 'POST')
  }
  private receive(frame: Frame): void {
    const type = string(frame.type)
    const p = object(frame.properties)
    if (!this.sessionId) return
    const info =
      type === 'message.updated'
        ? object(p.info)
        : type === 'message.part.updated'
          ? object(p.part)
          : p
    if (info.sessionID !== this.sessionId) return
    if (type === 'message.updated') {
      this.roles.set(identifier(info.id), string(info.role))
      if (this.roles.size > 4096) throw new Error('Too many messages in a turn')
    } else if (type === 'message.part.delta') {
      if (p.field === 'text' && this.roles.get(identifier(p.messageID)) === 'assistant')
        this.delta(identifier(p.partID), string(p.delta))
    } else if (type === 'message.part.updated') {
      const id = identifier(info.id)
      if (info.type === 'text' && this.roles.get(identifier(info.messageID)) === 'assistant')
        this.text(id, string(info.text))
      else if (info.type === 'tool') {
        const state = object(info.state)
        this.emit({
          type: 'tool',
          tool: {
            kind: 'tool',
            id,
            name: identifier(info.tool),
            input: printable(state.input),
            output: printable(state.output ?? state.error),
            status:
              state.status === 'completed'
                ? 'completed'
                : state.status === 'error'
                  ? 'failed'
                  : 'running'
          }
        })
      }
    } else if (
      type === 'session.idle' ||
      (type === 'session.status' && object(p.status).type === 'idle')
    ) {
      this.questionIds.clear()
      this.finish()
    } else if (type === 'session.error')
      this.finish('failed', 'OpenCode could not complete this turn')
    else if (type === 'permission.asked') {
      const id = identifier(p.id)
      this.request(
        {
          id,
          kind: 'permission',
          title: `Allow ${identifier(p.permission)}?`,
          description: printable(p.patterns)
        },
        async (response) => {
          await this.http(`/permission/${encodeURIComponent(id)}/reply`, 'POST', {
            reply: 'decision' in response && response.decision === 'allow' ? 'once' : 'reject'
          })
        }
      )
    } else if (type === 'question.asked') {
      const id = identifier(p.id)
      const questions = list(p.questions).map(object)
      if (!questions.length || questions.length > 16) throw new Error('Invalid questions')
      const answers: string[][] = questions.map(() => [])
      const ids = questions.map((_, index) => `${id}:${index}`)
      this.questionIds.set(id, ids)
      const pending = new Set(ids)
      questions.forEach((q, index) => {
        this.request(
          {
            id: ids[index],
            kind: 'question',
            title: string(q.question),
            choices: list(q.options).map((option) => string(object(option).label))
          },
          async (response) => {
            if (!('answer' in response)) {
              for (const child of ids) this.cancelRequest(child)
              this.questionIds.delete(id)
              await this.http(`/question/${encodeURIComponent(id)}/reject`, 'POST')
              return
            }
            answers[index] = [response.answer]
            pending.delete(ids[index])
            if (!pending.size) {
              this.questionIds.delete(id)
              await this.http(`/question/${encodeURIComponent(id)}/reply`, 'POST', { answers })
            }
          }
        )
      })
    } else if (['permission.replied', 'question.replied', 'question.rejected'].includes(type)) {
      const id = identifier(p.requestID)
      this.cancelRequest(id)
      for (const child of this.questionIds.get(id) ?? []) this.cancelRequest(child)
      this.questionIds.delete(id)
    } else if (/permission|question/.test(type)) this.fail('Unsupported OpenCode interactive event')
  }
  override async dispose(): Promise<void> {
    this.lifetime.abort()
    await super.dispose()
  }
}
