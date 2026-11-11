/**
 * Replay a spoken-rendering helper call on a markdown file, against the REAL
 * model, with the prompt, the system prompt and the arguments the app sends
 * (`src/main/helpers/folio.ts`, `cli-args.ts`). Prints each rendering and its
 * time, block by block (PRDCT-4430); exits 1 when any reply does not parse
 * (no `<spoken>` text, or its blocks not numbered 1 to k as sent).
 *
 *   npx vite-node scripts/replay-spoken-call.ts <markdown-file> [--runs 1] [--model haiku]
 *
 * A manual probe that spends real (Haiku) calls on the machine's own `claude`
 * login: never run it from the test suite. `tests/fixtures/spoken-sample.md`
 * is an invented answer with each shape the prompt has a rule for.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { helperCliArgs } from '../src/main/helpers/cli-args'
import { spokenRenderingHelper } from '../src/main/helpers/folio'
import { clipText } from '../src/shared/helper-prompt'
import { SPOKEN_MAX_CHARS, parseSpokenReply, splitBlocks } from '../src/shared/spoken-rendering'

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg))
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
if (!file) {
  console.error(
    'usage: npx vite-node scripts/replay-spoken-call.ts <markdown-file> [--runs n] [--model m]'
  )
  process.exit(2)
}
const runs = Number(option('runs') ?? '1')
const model = option('model') ?? spokenRenderingHelper.model
const markdown = clipText(readFileSync(file, 'utf8').trim(), SPOKEN_MAX_CHARS)
const prompt = spokenRenderingHelper.buildPrompt(markdown)
const blocks = splitBlocks(markdown).length
const cliArgs = helperCliArgs(spokenRenderingHelper.systemPrompt, { model })
// The nested-session marker would make the CLI believe it runs inside a session.
const env = { ...process.env }
delete env.CLAUDECODE

console.log(
  `markdown: ${markdown.length} chars in ${blocks} blocks, prompt: ${prompt.length} chars, model: ${model}`
)
let bad = 0
for (let run = 1; run <= runs; run++) {
  const started = Date.now()
  const result = spawnSync(process.env.CLAVE_CLAUDE ?? 'claude', cliArgs, {
    input: prompt,
    encoding: 'utf8',
    env,
    timeout: spokenRenderingHelper.timeoutMs
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const spoken = result.status === 0 ? parseSpokenReply(result.stdout, blocks) : null
  if (spoken === null) bad++
  console.log(
    `#${run} ${seconds}s exit=${result.status ?? result.signal} ` +
      (spoken === null
        ? `NOT A RENDERING reply=${JSON.stringify(result.stdout.slice(0, 300))}`
        : `${spoken.text.length} chars`) +
      (result.stderr.trim() ? ` stderr=${JSON.stringify(result.stderr.trim().slice(0, 200))}` : '')
  )
  if (spoken)
    for (const block of spoken.blocks ?? [{ n: 1, text: spoken.text }])
      console.log(`--- block ${block.n}\n${block.text}`)
}
console.log(`${runs - bad} of ${runs} replies were spoken renderings`)
process.exit(bad === 0 ? 0 : 1)
