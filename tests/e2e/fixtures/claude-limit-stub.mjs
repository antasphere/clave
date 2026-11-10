// A local stand-in for `claude -p --input-format stream-json` whose account
// is out (PRDCT-4329): it answers the first message the way the real CLI did
// on 2026-09-26 (`chat-limit-switch.spec.mjs`), the synthetic "out of usage
// credits" reply, then ends with 143. It never calls a provider. One line per
// process in its working directory (`claude-limit-stub-processes.jsonl`).
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const LIMIT_REPLY =
  "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
const argv = process.argv.slice(2)
if (argv.includes('-p') && !argv.includes('--input-format')) {
  process.stdin.resume()
  process.stdin.on('end', () => {
    process.stdout.write('claude limit stub title\n')
    process.exit(0)
  })
} else {
  const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const sessionId = after('--resume') ?? after('--session-id')
  appendFileSync(
    path.join(process.cwd(), 'claude-limit-stub-processes.jsonl'),
    JSON.stringify({ pid: process.pid, argv }) + '\n',
    { mode: 0o600 }
  )
  const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
  createInterface({ input: process.stdin }).on('line', (line) => {
    let input
    try {
      input = JSON.parse(line)
    } catch {
      return
    }
    if (input.type === 'control_request') {
      emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: input.request_id,
          response: input.request?.subtype === 'initialize' ? { models: [], commands: [] } : {}
        }
      })
      return
    }
    if (input.type !== 'user') return
    emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'stub' })
    const message = {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: LIMIT_REPLY }]
    }
    emit({ type: 'assistant', message, session_id: sessionId })
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId })
    setTimeout(() => process.exit(143), 300)
  })
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
}
