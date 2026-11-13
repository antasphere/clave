import { describe, expect, it } from 'vitest'
import {
  ORB_STATES,
  TOOL_ORBS,
  orbThemeFor,
  resolveOrbState,
  toolOrb
} from '../../../../plugins/orbs/src/orbs'
import { THEMES } from '../store/session-types'

describe('resolveOrbState', () => {
  it('offers the nine orbs the library ships', () => {
    expect(ORB_STATES.map((s) => s.id)).toEqual([
      'working',
      'searching',
      'solving',
      'listening',
      'connecting',
      'weaving',
      'composing',
      'breathing',
      'shaping'
    ])
    for (const state of ORB_STATES) expect(resolveOrbState(state.id)).toBe(state.id)
  })
  it('falls back to the working orb', () => {
    expect(resolveOrbState(null)).toBe('working')
    expect(resolveOrbState('spinning')).toBe('working')
  })
})

describe('toolOrb', () => {
  it('names an orb for every kind the chat view describes, and breathes for the rest', () => {
    for (const kind of ['read', 'search', 'edit', 'command', 'skill', 'web', 'agent', 'other'])
      expect(ORB_STATES.some((s) => s.id === TOOL_ORBS[kind])).toBe(true)
    expect(toolOrb('telepathy')).toBe('breathing')
  })
})

describe('orbThemeFor', () => {
  it('decides the ink from the skin base, for every theme the app ships', () => {
    const expected: Record<(typeof THEMES)[number], 'dark' | 'light'> = {
      dark: 'dark',
      charcoal: 'dark',
      light: 'light',
      coffee: 'light'
    }
    for (const theme of THEMES) expect(orbThemeFor(theme)).toBe(expected[theme])
  })
})
