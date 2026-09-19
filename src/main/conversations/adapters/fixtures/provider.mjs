/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain JavaScript CLI fixture. */
// Deterministic local wire peer. No provider/network/auth calls.
import { createInterface } from 'node:readline'
const provider = process.argv[2]
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n')
if (process.env.EXPECT_NATIVE_RESUME && process.argv.includes('--session-dir')) process.exit(21)
if (process.env.EXPECT_RESUME && provider !== 'codex') {
  const flag = provider === 'claude' ? '--resume' : '--session'
  if (process.argv[process.argv.indexOf(flag) + 1] !== process.env.EXPECT_RESUME) process.exit(20)
}
if (provider === 'claude' && process.env.EXPECT_PERMISSION_MODES) {
  const modes = process.argv.flatMap((arg, index) =>
    arg === '--permission-mode'
      ? [process.argv[index + 1]]
      : arg.startsWith('--permission-mode=')
        ? [arg.slice('--permission-mode='.length)]
        : []
  )
  if (JSON.stringify(modes) !== process.env.EXPECT_PERMISSION_MODES) process.exit(22)
  if (
    process.argv.includes('--dangerously-skip-permissions') !==
    (process.env.EXPECT_PERMISSION_BYPASS === '1')
  )
    process.exit(23)
}
let turn = 0
let pending
let piActive = false
let preflightId
function finish() {
  if (provider === 'claude')
    emit({ type: 'result', subtype: 'success', session_id: 'claude-session' })
  if (provider === 'codex')
    emit({
      method: 'turn/completed',
      params: { threadId: 'codex-session', turn: { id: String(turn), status: 'completed' } }
    })
  if (provider === 'pi') {
    piActive = false
    emit({ type: 'agent_end', messages: [] })
    emit({ type: 'agent_settled' })
  }
}
function prompt(text) {
  turn++
  if (text === 'crash') return process.exit(7)
  if (text === 'malformed') return process.stdout.write('not-json\n')
  if (text === 'wait') return
  if (text === 'unknown' && provider === 'claude')
    return emit({
      type: 'control_request',
      request_id: 'unknown',
      request: { subtype: 'future_approval' }
    })
  if (text === 'unknown' && provider === 'codex')
    return emit({ id: 901, method: 'item/future/requestApproval', params: {} })
  if (text === 'unknown' && provider === 'pi')
    return emit({ type: 'extension_ui_request', id: 'unknown', method: 'future_input' })
  if (text === 'question') {
    pending = 'question'
    if (provider === 'claude')
      return emit({
        type: 'control_request',
        request_id: pending,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
        }
      })
    if (provider === 'codex')
      return emit({
        id: pending,
        method: 'item/tool/requestUserInput',
        params: {
          questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]
        }
      })
    if (provider === 'pi')
      return emit({
        type: 'extension_ui_request',
        id: pending,
        method: 'select',
        title: 'Which?',
        options: ['A', 'B']
      })
  }
  if (text === 'cancelpermission') {
    prompt('permission')
    setTimeout(() => {
      if (provider === 'claude') emit({ type: 'control_cancel_request', request_id: pending })
      if (provider === 'codex')
        emit({ method: 'serverRequest/resolved', params: { requestId: pending } })
    }, 20)
    return
  }
  if (text === 'permission' && provider === 'claude') {
    pending = 'approval'
    return emit({
      type: 'control_request',
      request_id: pending,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'echo safe' },
        tool_use_id: 'tool1'
      }
    })
  }
  if (text === 'permission' && provider === 'codex') {
    pending = 900
    return emit({
      id: pending,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'codex-session',
        turnId: String(turn),
        itemId: 'tool1',
        command: 'echo safe'
      }
    })
  }
  if (provider === 'claude') {
    emit({ type: 'system', subtype: 'init', session_id: 'claude-session' })
    emit({
      type: 'assistant',
      message: {
        id: `tool-message-${turn}`,
        content: [{ type: 'tool_use', id: `tool${turn}`, name: 'Read', input: { path: 'file' } }]
      }
    })
    emit({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: `tool${turn}`, content: 'read' }] }
    })
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: `m${turn}` } } })
    emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'héllo' } }
    })
    emit({
      type: 'assistant',
      message: { id: `m${turn}`, content: [{ type: 'text', text: 'héllo' }] }
    })
  }
  if (provider === 'codex') {
    emit({
      method: 'item/started',
      params: {
        threadId: 'codex-session',
        item: { type: 'commandExecution', id: `tool${turn}`, command: 'echo safe' }
      }
    })
    emit({
      method: 'item/completed',
      params: {
        threadId: 'codex-session',
        item: {
          type: 'commandExecution',
          id: `tool${turn}`,
          command: 'echo safe',
          aggregatedOutput: 'safe',
          status: 'completed'
        }
      }
    })
    emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'codex-session', itemId: `m${turn}`, delta: 'héllo' }
    })
    emit({
      method: 'item/completed',
      params: {
        threadId: 'codex-session',
        item: { type: 'agentMessage', id: `m${turn}`, text: 'héllo' }
      }
    })
  }
  if (provider === 'pi') {
    emit({
      type: 'tool_execution_start',
      toolCallId: `tool${turn}`,
      toolName: 'read',
      args: { path: 'file' }
    })
    emit({
      type: 'tool_execution_end',
      toolCallId: `tool${turn}`,
      toolName: 'read',
      result: 'read',
      isError: false
    })
    emit({ type: 'message_start', message: { role: 'assistant' } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'héllo' } })
    emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'héllo' }] }
    })
  }
  finish()
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const v = JSON.parse(line)
  if (provider === 'claude') {
    if (v.type === 'control_request') {
      emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: v.request_id, response: {} }
      })
      if (v.request.subtype === 'interrupt') finish()
    } else if (v.type === 'user') prompt(v.message.content)
    else if (v.type === 'control_response' && v.response.request_id === pending) {
      emit({
        type: 'assistant',
        message: {
          id: 'decision',
          content: [
            {
              type: 'text',
              text:
                pending === 'question'
                  ? JSON.stringify(v.response.response.updatedInput.answers)
                  : v.response.response.behavior
            }
          ]
        }
      })
      finish()
    }
  }
  if (provider === 'codex') {
    if (v.method === 'initialize') emit({ id: v.id, result: { userAgent: 'fixture/0.154.0' } })
    if (v.method === 'thread/start' || v.method === 'thread/resume') {
      if (
        process.env.EXPECT_RESUME &&
        (v.method !== 'thread/resume' || v.params.threadId !== process.env.EXPECT_RESUME)
      )
        process.exit(20)
      emit({ id: v.id, result: { thread: { id: v.params.threadId || 'codex-session' } } })
    }
    if (v.method === 'turn/start') {
      emit({ id: v.id, result: { turn: { id: String(turn + 1) } } })
      prompt(v.params.input[0].text)
    }
    if (v.method === 'turn/interrupt') {
      emit({ id: v.id, result: {} })
      finish()
    }
    if (v.id === pending && v.result) {
      emit({
        method: 'item/completed',
        params: {
          threadId: 'codex-session',
          item: {
            type: 'agentMessage',
            id: 'decision',
            text: pending === 'question' ? JSON.stringify(v.result.answers) : v.result.decision
          }
        }
      })
      finish()
    }
  }
  if (provider === 'pi') {
    if (v.type === 'get_state')
      emit({
        type: 'response',
        id: v.id,
        command: v.type,
        success: true,
        data: { sessionId: 'pi-session', isStreaming: piActive, isCompacting: false }
      })
    if (v.type === 'prompt') {
      if (v.message === 'preflight-question') {
        preflightId = v.id
        emit({
          type: 'extension_ui_request',
          id: 'preflight-question',
          method: 'input',
          title: 'Before starting?'
        })
        return
      }
      piActive = v.message !== 'handled'
      emit({ type: 'response', id: v.id, command: v.type, success: true })
      if (v.message === 'handled') return
      if (v.message === 'retry') {
        emit({
          type: 'message_end',
          message: { role: 'assistant', content: [], stopReason: 'error' }
        })
        emit({ type: 'agent_end', messages: [] })
        emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Retry pending' }
        })
        setTimeout(() => {
          emit({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Recovered' }],
              stopReason: 'stop'
            }
          })
          finish()
        }, 200)
        return
      }
      prompt(v.message)
    }
    if (v.type === 'abort') {
      emit({ type: 'response', id: v.id, command: v.type, success: true })
      finish()
    }
    if (v.type === 'extension_ui_response' && v.id === 'preflight-question') {
      emit({ type: 'response', id: preflightId, command: 'prompt', success: true })
    }
    if (v.type === 'extension_ui_response' && v.id === 'question') {
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: v.value ?? 'cancelled' }] }
      })
      finish()
    }
  }
})
