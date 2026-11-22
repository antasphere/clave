import { expect, it, vi } from 'vitest'

const read = vi.hoisted(() => {
  const noop = (): void => undefined
  const fn = { calls: 0 }
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    window: {
      addEventListener: noop,
      removeEventListener: noop,
      electronAPI: {
        getAntigravityUsageLimits: async () => {
          fn.calls++
          return { error: 'Sign in to Antigravity' }
        }
      }
    },
    document: { addEventListener: noop, removeEventListener: noop, hidden: false }
  })
  return fn
})
import { refreshAntigravityUsageAfterTurn, useAntigravityUsageStore } from './usage-store'

it('reads after a turn at most once a minute, a failed read included', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  refreshAntigravityUsageAfterTurn()
  await vi.waitFor(() => expect(useAntigravityUsageStore.getState().status).toBe('error'))
  refreshAntigravityUsageAfterTurn()
  await Promise.resolve()
  expect(read.calls).toBe(1)
  vi.useRealTimers()
})
