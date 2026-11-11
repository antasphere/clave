/**
 * Replay a tab-title helper call on a message file, against the REAL model,
 * with the prompt, the system prompt and the arguments the app sends
 * (`src/main/helpers/title.ts`, `cli-args.ts`). Prints each reply, its time
 * and the title read from it; exits 1 when any reply is not a one-line title.
 *
 *   npx vite-node scripts/replay-title-call.ts <message-file> [--runs 3] [--model haiku]
 *
 * A manual probe that spends real (cheap, Haiku) calls on the machine's own
 * `claude` login: never run it from the test suite. Filed from the PRDCT-4326
 * measurements, where the old prompt answered a long first message instead of
 * titling it four times in five.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { helperCliArgs } from '../src/main/helpers/cli-args'
import { parseTitleReply, titleHelper } from '../src/main/helpers/title'

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg))
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
if (!file) {
  console.error(
    'usage: npx vite-node scripts/replay-title-call.ts <message-file> [--runs n] [--model m]'
  )
  process.exit(2)
}
const runs = Number(option('runs') ?? '1')
const model = option('model') ?? titleHelper.model
const message = readFileSync(file, 'utf8').trim()
const prompt = titleHelper.buildPrompt(message)
const cliArgs = helperCliArgs(titleHelper.systemPrompt, { model })
// The nested-session marker would make the CLI believe it runs inside a session.
const env = { ...process.env }
delete env.CLAUDECODE

console.log(`message: ${message.length} chars, prompt: ${prompt.length} chars, model: ${model}`)
let bad = 0
for (let run = 1; run <= runs; run++) {
  const started = Date.now()
  const result = spawnSync(process.env.CLAVE_CLAUDE ?? 'claude', cliArgs, {
    input: prompt,
    encoding: 'utf8',
    env,
    timeout: titleHelper.timeoutMs
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const title = result.status === 0 ? parseTitleReply(result.stdout) : null
  if (title === null) bad++
  console.log(
    `#${run} ${seconds}s exit=${result.status ?? result.signal} ` +
      (title === null ? 'NOT A TITLE' : `title=${JSON.stringify(title)}`) +
      ` reply=${JSON.stringify(result.stdout.slice(0, 300))}` +
      (result.stderr.trim() ? ` stderr=${JSON.stringify(result.stderr.trim().slice(0, 200))}` : '')
  )
}
console.log(`${runs - bad} of ${runs} replies were one-line titles`)
process.exit(bad === 0 ? 0 : 1)
