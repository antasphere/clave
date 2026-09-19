import { mkdir } from 'node:fs/promises'
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

export class PiAdapter extends BaseAdapter {
  readonly capabilities = {
    permissions: false,
    questions: true,
    resume: true,
    notice:
      'Pi RPC has no tool approval protocol. Tools run under Pi configuration. Extension questions are supported.'
  }
  private messageId = ''
  private failed = false
  private turn = 0
  protected async boot(): Promise<void> {
    validateArgs(this.launch, [
      '--mode',
      '--print',
      '-p',
      '--session',
      '--session-id',
      '--session-dir',
      '--continue',
      '-c',
      '--resume',
      '-r',
      '--fork',
      '--no-session',
      '--export',
      '--list-models'
    ])
    const options = this.launch.options
    const resume = this.launch.providerSessionId ?? options.resumeSessionId
    await mkdir(this.launch.sessionDirectory, { recursive: true, mode: 0o700 })
    const args = [
      '--mode',
      'rpc',
      // A history UUID belongs to Pi's native store. Moving its lookup to a
      // fresh Clave directory would make that resumable session disappear.
      ...(options.resumeSessionId ? [] : ['--session-dir', this.launch.sessionDirectory]),
      ...(resume ? ['--session', resume] : []),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.piProvider ? ['--provider', options.piProvider] : []),
      ...(options.piThinking ? ['--thinking', options.piThinking] : [])
    ]
    const parser = new JsonLines((frame) => this.receive(frame))
    this.process.start(
      this.launch,
      args,
      (chunk) => parser.push(chunk),
      () => parser.end()
    )
    const state = await this.call('get_state')
    if (typeof state.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean') {
      throw new Error('Pi RPC state flags are unavailable')
    }
    this.providerSession(identifier(state.sessionId))
  }
  private call(type: string, args: Frame = {}): Promise<Frame> {
    return this.rpc.call((id) => this.process.write({ id, type, ...args }))
  }
  protected async prompt(text: string): Promise<void> {
    this.messageId = this.newMessageId()
    this.failed = false
    const turn = ++this.turn
    // Pi preflight can ask an extension question before acknowledging prompt.
    // Acknowledge the pipe write to Clave so the user can answer that question.
    // The one outstanding prompt RPC has no wall-clock timeout while a human
    // may be answering; process exit, explicit Stop, and disposal still bound it.
    await new Promise<void>((resolve, reject) => {
      void this.rpc
        .call(async (id) => {
          await this.process.write({ id, type: 'prompt', message: text })
          resolve()
        }, 0)
        .then(async () => {
          if (this.dead || !this.active || this.turn !== turn) return
          // Pi reports preflight success only after either handling the input
          // itself or synchronously marking an agent run active. A handled slash
          // command/input hook has no agent_settled event, so query its state.
          const state = await this.call('get_state')
          if (this.turn === turn && state.isStreaming === false && state.isCompacting === false) {
            this.finish()
          }
        })
        .catch(() => {
          reject(new Error('Pi did not accept the prompt'))
          if (!this.dead) this.fail('Pi did not accept the prompt')
        })
    })
  }
  protected async abort(): Promise<void> {
    await this.call('abort')
  }
  private receive(frame: Frame): void {
    const type = string(frame.type)
    if (type === 'response') this.rpc.settle(frame.id, frame.data, frame.success !== true)
    else if (type === 'message_start') {
      if (object(frame.message).role === 'assistant') this.messageId = this.newMessageId()
    } else if (type === 'message_update') {
      const event = object(frame.assistantMessageEvent)
      if (event.type === 'text_delta') this.delta(this.messageId, string(event.delta))
    } else if (type === 'message_end') {
      const message = object(frame.message)
      if (message.role !== 'assistant') return
      const text = list(message.content)
        .map(object)
        .filter((b) => b.type === 'text')
        .map((b) => string(b.text))
        .join('')
      if (text) this.text(this.messageId, text)
      this.failed = message.stopReason === 'error'
      if (message.stopReason === 'aborted') this.interrupted = true
    } else if (type === 'agent_settled')
      this.finish(
        this.failed ? 'failed' : 'completed',
        this.failed ? 'Pi could not complete this turn' : undefined
      )
    else if (
      type === 'tool_execution_start' ||
      type === 'tool_execution_update' ||
      type === 'tool_execution_end'
    ) {
      this.emit({
        type: 'tool',
        tool: {
          kind: 'tool',
          id: identifier(frame.toolCallId),
          name: identifier(frame.toolName),
          ...(frame.args !== undefined ? { input: printable(frame.args) } : {}),
          ...(frame.result !== undefined || frame.partialResult !== undefined
            ? { output: printable(frame.result ?? frame.partialResult) }
            : {}),
          status:
            type === 'tool_execution_end' ? (frame.isError ? 'failed' : 'completed') : 'running'
        }
      })
    } else if (type === 'extension_ui_request') {
      const id = identifier(frame.id)
      const method = identifier(frame.method)
      if (['select', 'confirm', 'input', 'editor'].includes(method)) {
        this.request(
          {
            id,
            kind: 'question',
            title: typeof frame.title === 'string' ? frame.title : 'Pi extension question',
            ...(typeof frame.message === 'string' ? { description: frame.message } : {}),
            ...(Array.isArray(frame.options) ? { choices: frame.options.map(string) } : {})
          },
          async (response) => {
            await this.process.write({
              type: 'extension_ui_response',
              id,
              ...(method === 'confirm'
                ? {
                    confirmed:
                      'decision' in response
                        ? response.decision === 'allow'
                        : response.answer.toLowerCase() === 'yes'
                  }
                : 'answer' in response
                  ? { value: response.answer }
                  : { cancelled: true })
            })
          },
          typeof frame.timeout === 'number' ? frame.timeout : undefined
        )
      } else if (
        !['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(method)
      ) {
        void this.process.write({ type: 'extension_ui_response', id, cancelled: true }).then(
          () => this.fail('Unsupported Pi extension UI request'),
          () => this.fail('Pi input closed')
        )
      }
    }
  }
}
