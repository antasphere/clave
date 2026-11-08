import { describe, expect, it } from 'vitest'
import { effortLabel, isValidEffort } from './effort'

describe('reasoning effort', () => {
  it.each(['low', 'medium', 'xhigh', 'max', 'ultra', 'turbo_x', 'level-2', 'a'.repeat(32)])(
    'accepts %s',
    (effort) => expect(isValidEffort(effort)).toBe(true)
  )

  it.each(['', 'High', '--x', '-low', 'high;rm', 'high rm', '2high', 'hi/gh', 'a'.repeat(33)])(
    'rejects %j',
    (effort) => expect(isValidEffort(effort)).toBe(false)
  )

  it('reads a known level by its name and an unknown one as its own word', () => {
    expect(effortLabel('xhigh')).toBe('Extra high')
    expect(effortLabel('low')).toBe('Low')
    expect(effortLabel('max')).toBe('Max')
    expect(effortLabel('turbo_x')).toBe('Turbo x')
    expect(effortLabel('deep-think')).toBe('Deep think')
  })
})
