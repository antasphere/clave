import { randomUUID } from 'node:crypto'
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

export class ClaudeAdapter extends BaseAdapter {
  readonly capabilities = { permissions: true, questions: true, resume: true }
  private messageId = ''
  private tools = new Map<string, string>()
  private questionIds = new Map<string, string[]>()
  protected async boot(): Promise<void> {
    validateArgs(this.launch, [
      '--print',
      '-p',
      '--input-format',
      '--output-format',
      '--permission-prompt-tool',
      '--include-partial-messages',
      '--resume',
      '-r',
      '--continue',
      '-c',
      '--session-id',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      '--no-session-persistence',
      '--fork-session',
      '--background',
      '--bg',
      '--remote',
      '--json-schema'
    ])
    const options = this.launch.options
    const resume = this.launch.providerSessionId ?? options.resumeSessionId
    const id = resume ?? randomUUID()
    const mcpConfig =
      'mcpConfigPath' in this.launch && typeof this.launch.mcpConfigPath === 'string'
        ? ['--mcp-config', this.launch.mcpConfigPath]
        : []
    const args = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      ...mcpConfig,
      ...(resume ? ['--resume', id] : ['--session-id', id]),
      ...(options.model ? ['--model', options.model] : []),
      // The trusted profile and native Claude settings own permission mode.
      // Supplying "default" here overrides permissions.defaultMode, including auto.
      ...(options.dangerousMode ? ['--dangerously-skip-permissions'] : [])
    ]
    const parser = new JsonLines((frame) => this.receive(frame))
    this.process.start(
      this.launch,
      args,
      (chunk) => parser.push(chunk),
      () => parser.end()
    )
    await this.control({ subtype: 'initialize', hooks: {} })
    this.providerSession(id)
  }
  private control(request: Frame): Promise<Frame> {
    return this.rpc.call((id) =>
      this.process.write({ type: 'control_request', request_id: id, request })
    )
  }
  protected async prompt(text: string): Promise<void> {
    this.tools.clear()
    this.messageId = ''
    await this.process.write({
      type: 'user',
      session_id: this.sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: text }
    })
  }
  protected async abort(): Promise<void> {
    await this.control({ subtype: 'interrupt' })
  }
  private reply(id: string, response: Frame): Promise<void> {
    return this.process.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response }
    })
  }
  private permission(frame: Frame): void {
    const id = identifier(frame.request_id)
    const request = object(frame.request)
    if (request.subtype !== 'can_use_tool') {
      void this.process
        .write({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: id,
            error: 'Unsupported control request'
          }
        })
        .then(
          () => this.fail('Claude requested an unsupported control operation'),
          () => this.fail('Claude input closed')
        )
      return
    }
    const name = identifier(request.tool_name)
    const input = object(request.input)
    if (name === 'AskUserQuestion') {
      const questions = list(input.questions).map(object)
      if (!questions.length || questions.length > 16) throw new Error('Invalid questions')
      const answers: Record<string, string> = Object.create(null)
      const pending = new Set<number>()
      const ids = questions.map((_, i) => `${id}:${i}`)
      this.questionIds.set(id, ids)
      questions.forEach((q, index) => {
        pending.add(index)
        const question = string(q.question)
        const choices = list(q.options).map((option) => string(object(option).label))
        this.request(
          { id: ids[index], kind: 'question', title: question, choices },
          async (response) => {
            if (!('answer' in response)) {
              for (const child of ids) this.cancelRequest(child)
              this.questionIds.delete(id)
              await this.reply(id, { behavior: 'deny', message: 'User declined the question' })
              return
            }
            answers[question] = response.answer
            pending.delete(index)
            if (!pending.size) {
              this.questionIds.delete(id)
              await this.reply(id, { behavior: 'allow', updatedInput: { ...input, answers } })
            }
          }
        )
      })
      return
    }
    this.request(
      { id, kind: 'permission', title: `Allow ${name}?`, description: printable(input) },
      async (response) => {
        await this.reply(
          id,
          'decision' in response && response.decision === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Denied by user' }
        )
      }
    )
  }
  private receive(frame: Frame): void {
    const type = string(frame.type)
    if (typeof frame.session_id === 'string' && frame.session_id !== this.sessionId)
      this.providerSession(identifier(frame.session_id))
    if (type === 'control_response') {
      const response = object(frame.response)
      this.rpc.settle(response.request_id, response.response, response.subtype !== 'success')
    } else if (type === 'control_request') this.permission(frame)
    else if (type === 'control_cancel_request') {
      const id = identifier(frame.request_id)
      this.cancelRequest(id)
      for (const child of this.questionIds.get(id) ?? []) this.cancelRequest(child)
      this.questionIds.delete(id)
    } else if (type === 'stream_event' && !frame.parent_tool_use_id) {
      const event = object(frame.event)
      if (event.type === 'message_start') this.messageId = identifier(object(event.message).id)
      else if (event.type === 'content_block_delta') {
        const delta = object(event.delta)
        if (delta.type === 'text_delta') {
          if (!this.messageId) throw new Error('Text without a message')
          this.delta(this.messageId, string(delta.text))
        }
      } else if (event.type === 'content_block_start') {
        const block = object(event.content_block)
        if (block.type === 'tool_use') this.tool(block)
      }
    } else if (type === 'assistant') {
      const message = object(frame.message)
      const id = identifier(message.id)
      const blocks = list(message.content).map(object)
      // Authoritative snapshot replaces streamed text under the same provider id.
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => string(b.text))
        .join('')
      if (text && !frame.parent_tool_use_id) this.text(id, text)
      for (const block of blocks) if (block.type === 'tool_use') this.tool(block)
    } else if (type === 'user') {
      const content = object(frame.message).content
      if (Array.isArray(content))
        for (const value of content) {
          const block = object(value)
          if (block.type !== 'tool_result') continue
          const id = identifier(block.tool_use_id)
          this.emit({
            type: 'tool',
            tool: {
              kind: 'tool',
              id,
              name: this.tools.get(id) ?? 'Tool',
              status: block.is_error ? 'failed' : 'completed',
              output: printable(block.content)
            }
          })
          this.tools.delete(id)
        }
    } else if (type === 'result') {
      this.questionIds.clear()
      this.finish(
        frame.is_error ? 'failed' : 'completed',
        frame.is_error ? 'Claude could not complete this turn' : undefined
      )
    }
  }
  private tool(block: Frame): void {
    const id = identifier(block.id)
    const name = identifier(block.name)
    this.tools.set(id, name)
    if (this.tools.size > 4096) throw new Error('Too many tool calls')
    this.emit({
      type: 'tool',
      tool: { kind: 'tool', id, name, input: printable(block.input), status: 'running' }
    })
  }
}
