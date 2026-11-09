import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const locator = {}
  for (const method of ['locator', 'last']) locator[method] = () => locator
  locator.waitFor = vi.fn()
  locator.hover = vi.fn()
  locator.evaluate = vi.fn(() => true)
  return { locator, evaluate: vi.fn(), close: vi.fn() }
})
vi.mock('./harness.mjs', () => ({ until: async (read) => read() }))
vi.mock('./chat-view.spec.mjs', () => ({
  inject: vi.fn(),
  openChat: async () => ({
    win: { locator: () => fixture.locator, evaluate: fixture.evaluate },
    record: { id: 'fixture' },
    fixture: {},
    close: fixture.close
  })
}))
import { run as footer } from './chat-turn-foot.spec.mjs'

const source = ts.createSourceFile(
  'renderer-responsiveness.spec.mjs',
  readFileSync(new URL('./renderer-responsiveness.spec.mjs', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
)
const timingChecks = []
function visit(node) {
  if (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.getText(source).includes('permission rendering bypasses the text deadline')
  )
    timingChecks.push(node.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)

function recorder() {
  const results = []
  return { results, check: (name, ok, detail) => results.push({ name, ok: !!ok, detail }) }
}

beforeEach(() => vi.clearAllMocks())

describe('assertion failures preserve the remaining report coverage', () => {
  it.each([74.9, 75, 86.4])(
    'records the unchanged 75 ms boundary at %s ms without aborting',
    (ms) => {
      expect(timingChecks).toHaveLength(1)
      const t = recorder()
      // Execute the real spec statement, including its comparison and report call.
      const execute = new Function('assert', 't', 'control', timingChecks[0])
      expect(() => execute(assert, t, { arrived: 100, painted: 100 + ms })).not.toThrow()
      t.check('the independent assertions after the timing check ran', true)
      expect(t.results).toHaveLength(2)
      expect(t.results[0].ok).toBe(ms < 75)
      expect(t.results[0].detail).toEqual({ arrived: 100, painted: 100 + ms })
      expect(t.results[1].ok).toBe(true)
    }
  )

  it.each([
    { atEnd: true, shown: true, metaBottom: 786, expected: [true, true, true] },
    { atEnd: false, shown: true, metaBottom: 826, expected: [false, false, false] },
    { atEnd: true, shown: false, metaBottom: 786, expected: [false, false, false] },
    { atEnd: true, shown: true, metaBottom: 807, expected: [true, false, false] }
  ])('always evaluates all three footer checks, failing closed: %j', async (input) => {
    const { expected, ...state } = input
    const observed = { ...state, scrollerBottom: 806, composerTop: 806, textBottom: 766 }
    fixture.evaluate.mockResolvedValue(observed)
    const t = recorder()
    await footer(t)
    expect(t.results.map((result) => result.ok)).toEqual(expected)
    expect(t.results.map((result) => result.detail)).toEqual([observed, observed, observed])
    expect(fixture.close).toHaveBeenCalledOnce()
  })
})
