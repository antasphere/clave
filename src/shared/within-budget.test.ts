import { describe, expect, it } from 'vitest'
import { withinBudget } from './within-budget'

describe('withinBudget', () => {
  it('answers the value in time', async () => {
    expect(await withinBudget(Promise.resolve('models'), 50, 'unavailable')).toBe('models')
  })
  it('answers the fallback for work too slow, or failed', async () => {
    expect(await withinBudget(new Promise(() => {}), 20, 'unavailable')).toBe('unavailable')
    expect(await withinBudget(Promise.reject(new Error('x')), 50, 'unavailable')).toBe(
      'unavailable'
    )
  })
})
