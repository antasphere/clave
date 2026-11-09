import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForRegistryFailure } from './registry-failure.mjs'
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('__registryFailures', 0)
  vi.stubGlobal('__claveE2E', { plugins: { list: vi.fn() } })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const observer = () => ({ evaluate: vi.fn(async (read) => read()) })
describe('registry failure observation before fixture healing', () => {
  it('returns immediately for an observed failure, without reissuing the registry request', async () => {
    globalThis.__registryFailures = 1
    const fixture = observer()
    expect(await waitForRegistryFailure(fixture)).toBe(true)
    expect(fixture.evaluate).toHaveBeenCalledOnce()
    expect(globalThis.__claveE2E.plugins.list).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('waits for the delayed failure instead of treating the mounted terminal as evidence', async () => {
    const fixture = observer()
    let ready = false
    const completion = waitForRegistryFailure(fixture).then(() => {
      ready = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(ready).toBe(false)
    globalThis.__registryFailures = 1
    await vi.advanceTimersByTimeAsync(1)
    await completion
    expect(ready).toBe(true)
    expect(globalThis.__claveE2E.plugins.list).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('fails closed at ten seconds if no failure is observed', async () => {
    let error = null
    const completion = waitForRegistryFailure(observer()).catch((e) => {
      error = e
    })
    await vi.advanceTimersByTimeAsync(9999)
    expect(error).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await completion
    expect(error.message).toBe(
      'Registry fixture did not observe its injected failure within 10000 ms'
    )
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a stalled query and ignores its eventual late reply', async () => {
    let reply
    const fixture = {
      evaluate: vi.fn(
        () =>
          new Promise((resolve) => {
            reply = resolve
          })
      )
    }
    const completion = waitForRegistryFailure(fixture).catch((e) => e)
    await vi.advanceTimersByTimeAsync(10000)
    expect((await completion).message).toContain('within 10000 ms')
    reply(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.evaluate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates query errors and removes its deadline', async () => {
    const error = new Error('fixture unavailable')
    await expect(
      waitForRegistryFailure({
        evaluate: async () => {
          throw error
        }
      })
    ).rejects.toBe(error)
    expect(vi.getTimerCount()).toBe(0)
  })
})

it.each([null, undefined, 0])('propagates even a falsy query rejection: %s', async (reason) => {
  await expect(waitForRegistryFailure({ evaluate: () => Promise.reject(reason) })).rejects.toBe(
    reason
  )
  expect(vi.getTimerCount()).toBe(0)
})

it('awaits the observed failure before healing the registry fixture', () => {
  const file = new URL('../chat-registry-retry.spec.mjs', import.meta.url)
  const source = ts.createSourceFile(
    file.pathname,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  let observations = 0
  let ordered = false
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'waitForRegistryFailure'
    ) {
      observations++
      expect(ts.isAwaitExpression(node.parent)).toBe(true)
      expect(node.arguments.map((arg) => arg.getText(source))).toEqual(['fixture'])
    }
    if (ts.isBlock(node)) {
      for (const [index, statement] of node.statements.entries()) {
        if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression))
          continue
        const call = statement.expression.expression
        if (!ts.isCallExpression(call) || call.expression.getText(source) !== 'fixture.evaluate')
          continue
        const callback = call.arguments[0]
        if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) continue
        const statements = callback.body.statements
        if (
          statements.length !== 1 ||
          statements[0].getText(source).trim() !==
            'globalThis.__claveE2E.plugins.list = globalThis.__registryList'
        )
          continue
        expect(node.statements[index - 1]?.getText(source)).toBe(
          'await waitForRegistryFailure(fixture)'
        )
        ordered = true
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(observations).toBe(1)
  expect(ordered).toBe(true)
})
