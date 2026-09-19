import { BaseAdapter } from './base'
import {
  JsonLines,
  identifier,
  list,
  object,
  printable,
  string,
  validateArgs,
  type Frame
} from './transport'

export class CodexAdapter extends BaseAdapter {
  readonly capabilities = { permissions: true, questions: true, resume: true }
  private turnId?: string
  private questionIds = new Map<string, string[]>()
  protected async boot(): Promise<void> {
    validateArgs(this.launch, [
      '--listen',
      '--stdio',
      '--ws-auth',
      '--ws-token-file',
      '--ws-shared-secret-file',
      '--dangerously-bypass-approvals-and-sandbox',
      '--yolo',
      '--full-auto',
      '--sandbox',
      '-s',
      '--ask-for-approval',
      '-a',
      '--code-mode-host'
    ])
    const parser = new JsonLines((frame) => this.receive(frame))
    this.process.start(
      this.launch,
      ['app-server', '--listen', 'stdio://'],
      (chunk) => parser.push(chunk),
      () => parser.end()
    )
    await this.call('initialize', {
      clientInfo: { name: 'clave', title: 'Clave', version: '1.0.0' },
      capabilities: { experimentalApi: true }
    })
    await this.process.write({ method: 'initialized' })
    const options = this.launch.options
    const resume = this.launch.providerSessionId ?? options.resumeSessionId
    const response = await this.call(resume ? 'thread/resume' : 'thread/start', {
      ...(resume ? { threadId: resume } : {}),
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      approvalPolicy: options.dangerousMode ? 'never' : 'on-request',
      approvalsReviewer: 'user',
      sandbox: options.dangerousMode ? 'danger-full-access' : 'workspace-write'
    })
    this.providerSession(identifier(object(response.thread).id))
  }
  private call(method: string, params: Frame): Promise<Frame> {
    return this.rpc.call((id) => this.process.write({ id, method, params }))
  }
  protected async prompt(text: string): Promise<void> {
    this.turnId = undefined
    const response = await this.call('turn/start', {
      threadId: this.sessionId,
      input: [{ type: 'text', text, text_elements: [] }]
    })
    this.turnId = identifier(object(response.turn).id)
  }
  protected async abort(): Promise<void> {
    if (!this.turnId) throw new Error('Missing active turn id')
    await this.call('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId })
  }
  private serverRequest(frame: Frame): void {
    const wireId = frame.id
    if (typeof wireId !== 'string' && typeof wireId !== 'number') throw new Error('Invalid RPC id')
    const id = String(wireId)
    const params = object(frame.params)
    const reply = (result: Frame): Promise<void> => this.process.write({ id: wireId, result })
    if (
      frame.method === 'item/commandExecution/requestApproval' ||
      frame.method === 'item/fileChange/requestApproval'
    ) {
      this.request(
        {
          id,
          kind: 'permission',
          title:
            frame.method === 'item/fileChange/requestApproval'
              ? 'Allow file changes?'
              : 'Allow command execution?',
          description: printable(params.command ?? params.reason ?? params)
        },
        async (response) => {
          await reply({
            decision: 'decision' in response && response.decision === 'allow' ? 'accept' : 'decline'
          })
        }
      )
    } else if (frame.method === 'item/tool/requestUserInput') {
      const questions = list(params.questions).map(object)
      if (!questions.length || questions.length > 16) throw new Error('Invalid questions')
      if (questions.some((q) => q.isSecret === true)) {
        void reply({ answers: {} }).then(
          () => this.fail('Secret questions require a secure input channel'),
          () => this.fail('Codex input closed')
        )
        return
      }
      const answers: Record<string, { answers: string[] }> = Object.create(null)
      const ids = questions.map((_, index) => `${id}:${index}`)
      this.questionIds.set(id, ids)
      const pending = new Set(ids)
      questions.forEach((q, index) => {
        this.request(
          {
            id: ids[index],
            kind: 'question',
            title: string(q.question),
            ...(Array.isArray(q.options)
              ? { choices: q.options.map((o) => string(object(o).label)) }
              : {})
          },
          async (response) => {
            answers[identifier(q.id)] = { answers: 'answer' in response ? [response.answer] : [] }
            pending.delete(ids[index])
            if (!pending.size) {
              this.questionIds.delete(id)
              await reply({ answers })
            }
          }
        )
      })
    } else {
      // Never silently ignore a newer server request. An RPC error is a denial,
      // and terminating our connection prevents a stuck invisible approval.
      void this.process
        .write({ id: wireId, error: { code: -32601, message: 'Unsupported Clave client request' } })
        .then(
          () =>
            this.fail('Codex requested an unsupported operation. Update the conversation adapter.'),
          () => this.fail('Codex input closed')
        )
    }
  }
  private receive(frame: Frame): void {
    if (frame.id !== undefined && frame.method === undefined) {
      this.rpc.settle(frame.id, frame.result, frame.error !== undefined)
      return
    }
    const method = string(frame.method)
    if (frame.id !== undefined) {
      this.serverRequest(frame)
      return
    }
    const p = frame.params === undefined ? {} : object(frame.params)
    if (typeof p.threadId === 'string' && this.sessionId && p.threadId !== this.sessionId) return
    if (method === 'thread/started') this.providerSession(identifier(object(p.thread).id))
    else if (method === 'turn/started') this.turnId = identifier(object(p.turn).id)
    else if (method === 'item/agentMessage/delta') this.delta(identifier(p.itemId), string(p.delta))
    else if (method === 'item/started' || method === 'item/completed') {
      const item = object(p.item)
      const id = identifier(item.id)
      if (item.type === 'agentMessage') {
        if (method === 'item/completed') this.text(id, string(item.text))
      } else if (
        [
          'commandExecution',
          'fileChange',
          'mcpToolCall',
          'dynamicToolCall',
          'webSearch',
          'imageGeneration',
          'collabAgentToolCall'
        ].includes(string(item.type))
      ) {
        const status = item.status
        this.emit({
          type: 'tool',
          tool: {
            kind: 'tool',
            id,
            name: typeof item.tool === 'string' ? item.tool : string(item.type),
            input: printable(item.command ?? item.arguments ?? item.changes ?? item.query),
            output: printable(item.aggregatedOutput ?? item.result ?? item.error),
            status:
              status === 'failed' || status === 'declined'
                ? 'failed'
                : method === 'item/completed'
                  ? 'completed'
                  : 'running'
          }
        })
      }
    } else if (method === 'serverRequest/resolved') {
      const id = String(p.requestId)
      this.cancelRequest(id)
      for (const child of this.questionIds.get(id) ?? []) this.cancelRequest(child)
      this.questionIds.delete(id)
    } else if (method === 'turn/completed') {
      const turn = object(p.turn)
      if (!['completed', 'interrupted', 'failed'].includes(string(turn.status)))
        throw new Error('Unknown turn outcome')
      this.questionIds.clear()
      if (turn.status === 'interrupted') this.interrupted = true
      this.finish(
        turn.status === 'failed' ? 'failed' : 'completed',
        turn.status === 'failed' ? 'Codex could not complete this turn' : undefined
      )
    } else if (method === 'error' && p.willRetry !== true) {
      this.finish('failed', 'Codex reported a turn error')
    }
  }
}
