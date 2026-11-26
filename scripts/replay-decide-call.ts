/**
 * Replay a `tab-project` decision on an input file, against the REAL Jev,
 * with the request the app sends (`src/main/decisions/tab-project.ts`,
 * `jev-client.ts`). Prints the model that answered, the time, the reading
 * and the shares; exits 1 when the answer is not the documented shape.
 *
 *   TYPESAFE_API_KEY=… npx vite-node scripts/replay-decide-call.ts <input.json>
 *
 * The input is `{ tab, options, workspaceRoot, home }`, the decision's own
 * input (`scripts/fixtures/replay-decide-example.json` is an invented one).
 * The key is read from the environment and never printed. A manual probe
 * that spends a real request: never run it from the test suite (PRDCT-5179).
 */
import { readFileSync } from 'node:fs'
import { askJev } from '../src/main/decisions/jev-client'
import {
  basisOf,
  buildTabProjectRequest,
  readTabProjectAnswers,
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
  const request = buildTabProjectRequest(input)
  if (!request) {
    console.error('Nothing to ask: the tab said nothing, or there is no project.')
    return 1
  }
  const model = tabProjectDecision.model
  console.log(
    `request: ${JSON.stringify(request).length} chars, ${input.options.length} projects, model ${model}, basis ${basisOf(request, model).slice(0, 12)}`
  )
  const ask = (asked: string): ReturnType<typeof askJev> =>
    askJev({
      baseUrl: JEV_API,
      key,
      model: asked,
      request,
      timeoutMs: tabProjectDecision.timeoutMs
    })
  let outcome = await ask(model)
  // What the runner does (`runner.ts`): a model the service says it does not
  // know is asked once more on the fallback, so the replay sends what the app
  // sends and says it did.
  if (outcome.kind === 'model-gone' && tabProjectDecision.fallbackModel) {
    console.log(
      `the service does not know ${model}: asked again on ${tabProjectDecision.fallbackModel}, as the runner does`
    )
    outcome = await ask(tabProjectDecision.fallbackModel)
  }
  if (outcome.kind !== 'ok') {
    // Every outcome is already free of the key (`askJev` cleans what it keeps).
    console.log(`no answer: ${JSON.stringify(outcome)}`)
    return 1
  }
  console.log(
    `answered by ${outcome.model} in ${outcome.ms} ms, ${outcome.inputTokens ?? '?'} input tokens`
  )
  const reading = readTabProjectAnswers(outcome.answers, input)
  if (!reading) {
    console.log(`NOT THE DOCUMENTED SHAPE: ${JSON.stringify(outcome.answers).slice(0, 400)}`)
    return 1
  }
  const project = outcome.answers.project
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
