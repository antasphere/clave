/**
 * Replay a `tab-project` decision on an input file, against the REAL Jev,
 * with the request the app sends (`src/main/decisions/tab-project.ts`),
 * asked the way the app asks it: through the runner (`runner.ts`), so the
 * fallback model, the declared model asked once more and the retry after a
 * limit are the runner's by construction. Prints the model that answered,
 * the time, the reading and the shares; exits 1 when the answer is not the
 * documented shape.
 *
 *   TYPESAFE_API_KEY=… npx vite-node scripts/replay-decide-call.ts <input.json>
 *
 * The input is `{ tab, options, workspaceRoot, home }`, the decision's own
 * input (`scripts/fixtures/replay-decide-example.json` is an invented one).
 * The key is read from the environment and never printed. A manual probe
 * that spends a real request: never run it from the test suite (PRDCT-5179).
 */
import { readFileSync } from 'node:fs'
import { askJev, type AskJevOptions, type JevOutcome } from '../src/main/decisions/jev-client'
import { runDecision } from '../src/main/decisions/runner'
import {
  basisOf,
  tabProjectDecision,
  type TabProjectInput
} from '../src/main/decisions/tab-project'
import { JEV_API } from '../src/main/integrations/jev'

const file = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
if (!file) {
  console.error(
    'usage: TYPESAFE_API_KEY=… npx vite-node scripts/replay-decide-call.ts <input.json>'
  )
  process.exit(2)
}
const key = process.env.TYPESAFE_API_KEY?.trim()
if (!key) {
  console.error('No key: set TYPESAFE_API_KEY in the environment (it is never printed).')
  process.exit(2)
}

async function main(file: string, key: string): Promise<number> {
  const input = JSON.parse(readFileSync(file, 'utf8')) as TabProjectInput
  const request = tabProjectDecision.build(input)
  if (!request) {
    console.error('Nothing to ask: the tab said nothing, or there is no project.')
    return 1
  }
  const model = tabProjectDecision.model
  console.log(
    `request: ${JSON.stringify(request).length} chars, ${input.options.length} projects, model ${model}, basis ${basisOf(request, model).slice(0, 12)}`
  )
  // Every request the runner sends goes through here, `askJev` itself: each
  // one asked again is said, and the last answer is kept for its shares.
  const seen: { last: { model: string; outcome: JevOutcome } | null } = { last: null }
  const ask = async (asked: AskJevOptions): Promise<JevOutcome> => {
    const before = seen.last
    if (before?.outcome.kind === 'model-gone')
      console.log(
        `the service does not know ${before.model}: asked again on ${asked.model}, as the runner does`
      )
    else if (before?.outcome.kind === 'limit')
      console.log(
        `TypeSafe asked to wait: asked again on ${asked.model} after the pause, as the runner does`
      )
    const outcome = await askJev(asked)
    seen.last = { model: asked.model, outcome }
    return outcome
  }
  const decided = await runDecision(tabProjectDecision, input, {
    ask,
    openKey: async () => key,
    baseUrl: () => JEV_API
  })
  const last = seen.last?.outcome
  if (!decided.ok) {
    if (decided.reason === 'unreadable' && last?.kind === 'ok') {
      console.log(
        `answered by ${last.model} in ${last.ms} ms, ${last.inputTokens ?? '?'} input tokens`
      )
      console.log(`NOT THE DOCUMENTED SHAPE: ${JSON.stringify(last.answers).slice(0, 400)}`)
      return 1
    }
    // The service's last answer, as the replay always printed it (the
    // runner's own outcome when it sent nothing). Every outcome is already
    // free of the key (`askJev` cleans what it keeps).
    console.log(`no answer: ${JSON.stringify(last ?? decided)}`)
    return 1
  }
  console.log(
    `answered by ${decided.model} in ${decided.ms} ms, ${decided.inputTokens ?? '?'} input tokens`
  )
  const reading = decided.value
  const project = last?.kind === 'ok' ? last.answers.project : undefined
  const shares =
    project?.type === 'choice'
      ? Object.entries(project.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([name, p]) => `${name} ${(p * 100).toFixed(1)}%`)
          .join(', ')
      : ''
  console.log(`shares: ${shares}`)
  console.log(`fits: ${reading.fits.toFixed(3)}`)
  console.log(
    `reading: ${reading.status}${reading.picks.length ? ` — ${reading.picks.map((p) => `${p.name} ${(p.p * 100).toFixed(1)}%`).join(' | ')}` : ''}`
  )
  return 0
}

void main(file, key).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
)
