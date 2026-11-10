import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Run the spec's actual observation and its existing polling helpers. The
// driver models the two real prompts while the second Mac's status is stale.
function functionSource(file, name) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
  )
  if (!declaration) throw new Error(`missing polling function: ${name}`)
  return declaration.getText(source).replace(/^export\s+/, '')
}

const until = new Function(`return ${functionSource('./harness.mjs', 'until')}`)()
const eventually = new Function(
  'assert',
  'until',
  `return ${functionSource('./fixtures/fleet-world.mjs', 'eventually')}`
)(assert, until)
const source = readFileSync(new URL('./fleet-requests.spec.mjs', import.meta.url), 'utf8')
const start = source.indexOf("    let macBDock = ''")
const end = source.indexOf('    // Every record of the approval', start)
if (start < 0 || end < 0) throw new Error('second-Mac request observation missing')
const observe = new Function(
  'eventually',
  'dockOf',
  'macB',
  'nativeApproval',
  `return (async () => { ${source.slice(start, end)}; return macBDock })()`
)

const question = 'Same fleet label? Fleet public answer'
const approval = 'Fleet native approval without a Mac'

function page(initial) {
  let prompts = initial
  let failure = null
  function locator(pick = (nodes) => nodes) {
    return {
      async count() {
        if (failure) throw failure
        return pick(prompts).length
      },
      async innerText() {
        if (failure) throw failure
        const selected = pick(prompts)
        if (selected.length !== 1) throw new Error('strict mode violation: multiple prompts')
        return selected[0]
      },
      async evaluateAll(read) {
        if (failure) throw failure
        return read(pick(prompts).map((innerText) => ({ innerText })))
      },
      first() {
        return locator((nodes) => pick(nodes).slice(0, 1))
      }
    }
  }
  return {
    deliver(next) {
      prompts = next
    },
    disconnect() {
      failure = new Error('renderer disconnected')
    },
    run: () => observe(eventually, () => locator(), {}, { description: approval })
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the second Mac observes the question after the approval leaves', () => {
  it.each([
    { order: 'question first', prompts: [question, approval] },
    { order: 'approval first', prompts: [approval, question] }
  ])('waits for all prompt text to settle with $order', async ({ prompts }) => {
    const driver = page(prompts)
    let outcome = null
    const pending = driver.run().then(
      (text) => (outcome = { text }),
      (error) => (outcome = { error: error.message })
    )
    await vi.advanceTimersByTimeAsync(250)
    expect(outcome).toBeNull()
    driver.deliver([question])
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(outcome).toEqual({ text: question })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits through an empty observation until the expected question arrives', async () => {
    const driver = page([])
    let completed = false
    const pending = driver.run().then(() => (completed = true))
    await vi.advanceTimersByTimeAsync(250)
    expect(completed).toBe(false)
    driver.deliver([question])
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(completed).toBe(true)
  })

  it('still fails at the existing bound if the old approval never leaves', async () => {
    const driver = page([question, approval])
    let outcome = null
    const pending = driver.run().then(
      () => (outcome = 'completed'),
      (error) => (outcome = error.message)
    )
    await vi.advanceTimersByTimeAsync(11999)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toContain('the other Mac docks the question next')
    expect(outcome).toContain(question)
    expect(outcome).toContain(approval)
    await pending
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { state: 'empty', prompts: [] },
    { state: 'unrelated prompt', prompts: ['An unrelated prompt'] },
    { state: 'different Fleet question', prompts: ['Fleet private answer'] },
    { state: 'partial question label', prompts: ['Fleet public status'] },
    { state: 'other public answer', prompts: ['Other public answer'] }
  ])(
    'still fails at the existing bound when the question is missing: $state',
    async ({ prompts }) => {
      const driver = page(prompts)
      let outcome = null
      const pending = driver.run().then(
        () => (outcome = 'completed'),
        (error) => (outcome = error.message)
      )
      await vi.advanceTimersByTimeAsync(11999)
      expect(outcome).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome).toContain('the other Mac docks the question next')
      await pending
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('returns immediately when the expected question is already the only prompt', async () => {
    expect(await page([question]).run()).toBe(question)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a renderer read failure instead of treating it as settled', async () => {
    const driver = page([question])
    driver.disconnect()
    await expect(driver.run()).rejects.toThrow('renderer disconnected')
    expect(vi.getTimerCount()).toBe(0)
  })
})
