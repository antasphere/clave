import { describe, expect, it } from 'vitest'
import { activeNote, formatMinutes, formatTokens, formatUsd } from './format'

describe('the formats', () => {
  it('writes a cost with cents below a thousand dollars and whole dollars above', () => {
    expect(formatUsd(12.345)).toBe('$12.35')
    expect(formatUsd(391.2575)).toBe('$391.26')
    expect(formatUsd(1788.6)).toBe('$1,789')
  })
  it('writes minutes and hours', () => {
    expect(formatMinutes(48.4)).toBe('48 min')
    expect(formatMinutes(65)).toBe('1 h 05')
    expect(formatMinutes(1052.34)).toBe('17 h 32')
  })
  it('writes tokens in k, M and B', () => {
    expect(formatTokens(840)).toBe('840')
    expect(formatTokens(312_400)).toBe('312 k')
    expect(formatTokens(98_600_000)).toBe('98.6 M')
    expect(formatTokens(1_505_484_041)).toBe('1.51 B')
  })
  it('puts a session inside its wall clock and an aggregate across it, short enough for the tile', () => {
    expect(activeNote('session', 110)).toBe('over 1 h 50 wall')
    expect(activeNote('group', 965)).toBe('across 16 h 05 wall')
    expect(activeNote('workspace', 965)).toBe('across 16 h 05 wall')
    expect(activeNote('group', 965).length).toBeLessThanOrEqual('over 17 h 32 wall'.length + 2)
  })
})
