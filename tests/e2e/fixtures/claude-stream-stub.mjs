// A local stand-in for `claude -p --input-format stream-json` on a fleet
// daemon (PRDCT-4191). It never calls a provider: every user message is
// answered by replaying the recorded real turn (`real-turn.ndjson`) under the
// launch's session id, its init frame reporting `--stub-mode <mode>`
// (default `acceptEdits`) as the permission mode, and the assistant text
// echoing what it received. It records, in its working directory, one line
// per process (`claude-stub-processes.jsonl`: pid, argv) and one line per
// stdin frame (`claude-stub-input.jsonl`: pid, frame), so a spec reads what
// each process was launched with and what reached it.
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
// The title one-shot (`claude -p --model haiku`, no stream input): a title, nothing recorded.
if (argv.includes('-p') && !argv.includes('--input-format')) {
  process.stdin.resume()
  process.stdin.on('end', () => {
    process.stdout.write('claude stub title\n')
    process.exit(0)
  })
} else {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const frames = readFileSync(
    path.join(here, '../../../src/main/sessions/fixtures/claude-stream/real-turn.ndjson'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const sessionId = after('--resume') ?? after('--session-id')
  // The mode the CLI was launched in is the mode its init frame reports, as
  // the real CLI does; `--stub-mode` names the one a first launch pretends
  // the person switched to. The real CLI refuses `default` on its command
  // line (the running name; `manual` is the flag's), and so does the stub.
  const launched = after('--permission-mode')
  if (launched === 'default') {
    process.stderr.write('error: invalid --permission-mode default (use manual)\n')
    process.exit(2)
  }
  const mode =
    (launched === 'manual' ? 'default' : launched) ?? after('--stub-mode') ?? 'acceptEdits'
  const log = (file, value) =>
    appendFileSync(path.join(process.cwd(), file), JSON.stringify(value) + '\n', { mode: 0o600 })
  log('claude-stub-processes.jsonl', { pid: process.pid, argv })
  const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
  const text = (content) =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((c) => c?.text ?? '').join('')
        : ''
  createInterface({ input: process.stdin }).on('line', (line) => {
    let input
    try {
      input = JSON.parse(line)
    } catch {
      return
    }
    log('claude-stub-input.jsonl', { pid: process.pid, frame: input })
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
    const said = text(input.message?.content)
    for (const frame of frames) {
      const copy = structuredClone(frame)
      if (copy.session_id) copy.session_id = sessionId
      if (copy.type === 'system' && copy.subtype === 'init') copy.permissionMode = mode
      if (copy.type === 'assistant')
        copy.message.content = [{ type: 'text', text: `stub heard: ${said}` }]
      if (copy.type === 'stream_event' && copy.event?.delta?.type === 'text_delta')
        copy.event.delta.text = `stub heard: ${said}`
      emit(copy)
    }
  })
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
}
