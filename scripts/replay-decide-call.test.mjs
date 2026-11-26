/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of a by-hand script */
/**
 * The replay asks what the runner asks (PRDCT-5179): `replay-decide-call.ts`
 * sends the app's own tab-project request through `runDecision`, so the
 * fallback model, the declared model asked once more and the retry after a
 * limit are the runner's by construction. Run here on a stubbed `fetch`: no
 * request leaves the machine, and the key is invented.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(DIR, 'replay-decide-call.ts')
const EXAMPLE = path.join(DIR, 'fixtures', 'replay-decide-example.json')
const KEY = 'ts-invented-replay-key-0001'

const answers = {
  project: {
    type: 'choice',
    choice: 'Quill',
    confidence: 0.9,
    probabilities: { Quill: 0.9, Atlas: 0.07, Lumen: 0.03 }
  },
  fits: { type: 'noul', noul: 0.96 }
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers })
const ok = (model) => json(200, { model, answers, usage: { input_tokens: 640, output_tokens: 3 } })
const gone = (model) => json(404, { detail: `Unknown model ${model}` })
const limited = () => json(429, { detail: 'Too many requests' }, { 'retry-after': '0' })
const refused = () => json(401, { detail: 'Invalid API key' })

/** The script run once on the invented example, the service answering
 *  `plan` in turn; what it sent, printed and exited with. */
async function replay(plan) {
  const sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      sent.push({
        path: new URL(String(url)).pathname,
        model: body.model,
        bearer: new Headers(init?.headers).get('authorization') === `Bearer ${KEY}`
      })
      return plan[Math.min(sent.length - 1, plan.length - 1)](body.model)
    })
  )
  const lines = []
  vi.spyOn(console, 'log').mockImplementation((line) => void lines.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line) => void lines.push(String(line)))
  const exited = new Promise((resolve) =>
    vi.spyOn(process, 'exit').mockImplementation((code) => resolve(code))
  )
  const argv = process.argv
  process.argv = [argv[0], SCRIPT, EXAMPLE]
  vi.stubEnv('TYPESAFE_API_KEY', KEY)
  vi.resetModules()
  try {
    await import(SCRIPT)
    const code = await exited
    return { code, sent, lines }
  } finally {
    process.argv = argv
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the replay of a tab-project decision', () => {
  it('prints what it printed: the request, the model, the shares, the reading', async () => {
    const { code, sent, lines } = await replay([ok])
    expect(code).toBe(0)
    expect(sent).toEqual([{ path: '/v1/systemone', model: 'jev-1.14.0', bearer: true }])
    expect(lines[0]).toMatch(
      /^request: \d+ chars, 3 projects, model jev-1\.14\.0, basis [0-9a-f]{12}$/
    )
    expect(lines.slice(1).map((line) => line.replace(/ in \d+ ms/, ' in N ms'))).toEqual([
      'answered by jev-1.14.0 in N ms, 640 input tokens',
      'shares: Quill 90.0%, Atlas 7.0%, Lumen 3.0%',
      'fits: 0.960',
      'reading: decided — Quill 90.0%'
    ])
    expect(lines.join('\n')).not.toContain(KEY)
  })

  it('asks the declared model once more when the fallback is refused too, as the runner does', async () => {
    const { code, sent, lines } = await replay([gone, gone, ok])
    expect(sent.map((s) => s.model)).toEqual(['jev-1.14.0', 'jev-latest', 'jev-1.14.0'])
    expect(lines).toContain(
      'the service does not know jev-latest: asked again on jev-1.14.0, as the runner does'
    )
    expect(code).toBe(0)
  })

  it('asks once more after a limit, as the runner does', async () => {
    const { code, sent, lines } = await replay([limited, ok])
    expect(sent.map((s) => s.model)).toEqual(['jev-1.14.0', 'jev-1.14.0'])
    expect(lines).toContain(
      'TypeSafe asked to wait: asked again on jev-1.14.0 after the pause, as the runner does'
    )
    expect(code).toBe(0)
  })

  it('a refused key: the service’s words, exit 1, the key never printed', async () => {
    const { code, lines } = await replay([refused])
    expect(code).toBe(1)
    expect(lines).toContain(
      'no answer: {"kind":"refused","sentence":"TypeSafe refused the key: Invalid API key."}'
    )
    expect(lines.join('\n')).not.toContain(KEY)
  })
})
