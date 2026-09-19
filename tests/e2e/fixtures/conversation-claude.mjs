// Deterministic CLI protocol fixture. No network, model, or real tool execution.
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

if (process.argv.includes('--version')) {
  console.log('2.1.274 (Claude Code)')
  process.exit(0)
}
const argument = (flag) => process.argv[process.argv.indexOf(flag) + 1]
const sessionId = process.argv.includes('--resume')
  ? argument('--resume')
  : process.argv.includes('--session-id')
    ? argument('--session-id')
    : randomUUID()
const state = {
  pid: process.pid,
  turns: 0,
  sessionId,
  claveId: process.env.CLAVE_SESSION_ID,
  configDir: process.env.CLAUDE_CONFIG_DIR,
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  args: process.argv.slice(2)
}
const save = () => writeFileSync(join(process.cwd(), 'fixture-state.json'), JSON.stringify(state))
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let timer
const complete = (text) => {
  const id = `message-${state.turns}`
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
  emit({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false })
}
save()
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id, response: {} }
    })
    if (message.request.subtype === 'interrupt') {
      clearTimeout(timer)
      complete('Interrupted fixture turn')
    }
  } else if (message.type === 'user') {
    state.turns++
    save()
    const text = message.message.content
    if (text === 'permission') {
      emit({
        type: 'control_request',
        request_id: 'permission-one',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'echo fixture' },
          tool_use_id: 'fixture-tool'
        }
      })
    } else if (text === 'background') {
      timer = setTimeout(() => complete('Finished while Clave was closed'), 1500)
    } else if (text !== 'wait') {
      complete(`**Fixture reply:** ${text}`)
    }
  } else if (message.type === 'control_response') {
    complete(`Permission ${message.response.response.behavior === 'allow' ? 'allowed' : 'denied'}`)
  }
})
