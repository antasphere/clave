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

function namedCheck(statement, name) {
  return (
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    statement.expression.arguments[0]?.text === name
  )
}
const runBody = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'run'
).body
const reportStatements = runBody.statements.find(ts.isTryStatement).tryBlock.statements
const permissionIndex = reportStatements.findIndex((statement) =>
  namedCheck(statement, 'permission rendering bypasses the text deadline')
)
const metadataIndex = reportStatements.findIndex((statement) =>
  namedCheck(
    statement,
    'a permission request and live model/state metadata bypass unfinished text scheduling'
  )
)
const reportSequence = reportStatements
  .slice(permissionIndex, metadataIndex + 1)
  .map((statement) => statement.getText(source))
  .join('\n')
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor

function recorder() {
  const results = []
  return {
    results,
    check: (name, ok, detail) => results.push({ name, ok: !!ok, detail })
  }
}

beforeEach(() => vi.clearAllMocks())

describe('assertion failures preserve the remaining report coverage', () => {
  it('has no run-level early return after recording permission latency', () => {
    const returns = []
    const visitTail = (node) => {
      if (ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node)) returns.push(node.getText(source))
      ts.forEachChild(node, visitTail)
    }
    expect(permissionIndex).toBeGreaterThanOrEqual(0)
    for (const statement of reportStatements.slice(permissionIndex + 1)) visitTail(statement)
    expect(returns).toEqual([])
  })

  it.each([74.9, 75, 86.4])(
    'records the unchanged 75 ms boundary at %s ms without aborting',
    async (ms) => {
      expect(timingChecks).toHaveLength(1)
      expect(permissionIndex).toBeGreaterThanOrEqual(0)
      expect(metadataIndex).toBeGreaterThan(permissionIndex)
      const t = recorder()
      const observed = []
      const view = () => ({
        getByText: () => ({
          waitFor: async () => observed.push('control text observed')
        })
      })
      const host = {
        locator: (selector) => ({
          getAttribute: async () =>
            selector === '.chat-state' ? 'blocked' : 'responsiveness-model'
        })
      }
      // Execute the actual spec through its next independent named checkpoint.
      // A return or a second timing assertion must not suppress that checkpoint.
      const execute = new AsyncFunction(
        'assert',
        't',
        'control',
        'view',
        'host',
        'until',
        reportSequence
      )
      await execute(assert, t, { arrived: 100, painted: 100 + ms }, view, host, async (read) =>
        read()
      )
      expect(t.results.map((result) => result.name)).toEqual([
        'permission rendering bypasses the text deadline',
        'a permission request and live model/state metadata bypass unfinished text scheduling'
      ])
      expect(t.results[0].ok).toBe(ms < 75)
      expect(t.results[0].detail).toEqual({ arrived: 100, painted: 100 + ms })
      expect(t.results[1].ok).toBe(true)
      expect(observed).toEqual(['control text observed'])
    }
  )

  it.each([
    { atEnd: true, shown: true, metaBottom: 786, expected: [true, true, true] },
    {
      atEnd: false,
      shown: true,
      metaBottom: 826,
      expected: [false, false, false]
    },
    {
      atEnd: true,
      shown: false,
      metaBottom: 786,
      expected: [false, false, false]
    },
    {
      atEnd: true,
      shown: true,
      metaBottom: 807,
      expected: [true, false, false]
    },
    { atEnd: true, shown: true, metaBottom: 790, expected: [true, true, true] },
    {
      atEnd: true,
      shown: true,
      metaBottom: 791,
      expected: [true, true, false]
    }
  ])('always evaluates all three footer checks, failing closed: %j', async (input) => {
    const { expected, ...state } = input
    const observed = {
      ...state,
      scrollerBottom: 806,
      composerTop: 806,
      textBottom: 766
    }
    fixture.evaluate.mockResolvedValue(observed)
    const t = recorder()
    await footer(t)
    expect(t.results.map((result) => result.ok)).toEqual(expected)
    expect(t.results.map((result) => result.detail)).toEqual([observed, observed, observed])
    expect(fixture.close).toHaveBeenCalledOnce()
  })
})
