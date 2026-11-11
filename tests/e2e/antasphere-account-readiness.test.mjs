import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Execute the actual second-window observation, without launching Electron.
// The driver models the page before and after the account status arrives.
const source = readFileSync(
  new URL('./antasphere-account-attached.spec.mjs', import.meta.url),
  'utf8'
)
const start = source.indexOf('    const { section: section2 } = await openAccounts(win2)')
const end = source.indexOf('    await section2.getByRole(', start)
if (start < 0 || end < 0) throw new Error('second-window account observation missing')
const observe = new Function(
  'openAccounts',
  'win2',
  'until',
  'phaseOf',
  't',
  `return (async () => { ${source.slice(start, end)} })()`
)

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function page() {
  let loaded = false
  let cancelled = false
  const reads = []
  const section = {
    locator(selector) {
      return {
        async count() {
          if (selector !== '[data-antasphere-failure="cancelled"]')
            throw new Error(`unexpected count: ${selector}`)
          return Number(loaded && cancelled)
        },
        waitFor({ state, timeout }) {
          // The button itself is visible in the initial Reading placeholder.
          if (selector === '[data-antasphere-sign-in]' && state === 'visible')
            return Promise.resolve()
          if (selector !== '[data-antasphere-sign-in]:enabled' || state !== 'visible')
            throw new Error(`readiness must observe the enabled sign-in control: ${selector}`)
          if (loaded) return Promise.resolve()
          return new Promise((resolve, reject) => {
            const timer =
              timeout === 0
                ? null
                : setTimeout(() => reject(new Error('account read deadline')), timeout ?? 30_000)
            reads.push(() => {
              clearTimeout(timer)
              resolve()
            })
          })
        }
      }
    }
  }
  const checks = []
  const run = () =>
    observe(
      async () => ({ section }),
      {},
      async (fn) => fn(),
      async () => 'signed-out',
      { equal: (name, actual, expected) => checks.push({ name, actual, expected }) }
    )
  return {
    run,
    checks,
    deliver(failure) {
      loaded = true
      cancelled = failure === 'cancelled'
      for (const resolve of reads.splice(0)) resolve()
    }
  }
}

describe('the second window observes cancellation after its initial account read', () => {
  it('does not assert against the initial signed-out placeholder', async () => {
    const driver = page()
    const pending = driver.run()
    await vi.advanceTimersByTimeAsync(2000)
    expect(driver.checks).toEqual([])
    driver.deliver('cancelled')
    await pending
    expect(driver.checks).toEqual([
      { name: 'the second window sees the cancel too', actual: 1, expected: 1 }
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still records failure when the loaded account has lost the cancellation', async () => {
    const driver = page()
    driver.deliver(null)
    await driver.run()
    expect(driver.checks).toEqual([
      { name: 'the second window sees the cancel too', actual: 0, expected: 1 }
    ])
  })

  it('fails closed within ten seconds if the account never becomes ready', async () => {
    const driver = page()
    let outcome = null
    const pending = driver.run().then(
      () => (outcome = 'completed'),
      (error) => (outcome = error.message)
    )
    await vi.advanceTimersByTimeAsync(9999)
    expect(outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome).toBe('account read deadline')
    await pending
    expect(driver.checks).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
