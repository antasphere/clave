/**
 * The agent-run-state → session_state mapping (spec §1.3) and the
 * one-event-per-transition rule measured on the MAPPED state (invariant 6:
 * a no-op transition emits nothing — Clave's done↔idle included).
 */

import { describe, expect, it } from 'vitest'
import { mapAgentState, sessionStateTransition } from './session-state'

describe('mapAgentState', () => {
  it('working → working, blocked → blocked, idle and done → idle', () => {
    expect(mapAgentState('working')).toBe('working')
    expect(mapAgentState('blocked')).toBe('blocked')
    expect(mapAgentState('idle')).toBe('idle')
    expect(mapAgentState('done')).toBe('idle')
  })
})

describe('sessionStateTransition', () => {
  it('emits on a real transition with the mapped previous state', () => {
    expect(sessionStateTransition('working', 'blocked')).toEqual({
      previous: 'working',
      state: 'blocked'
    })
    expect(sessionStateTransition('blocked', 'working')).toEqual({
      previous: 'blocked',
      state: 'working'
    })
    expect(sessionStateTransition('working', 'done')).toEqual({
      previous: 'working',
      state: 'idle'
    })
  })

  it('the first word of a session has previous null', () => {
    expect(sessionStateTransition(undefined, 'working')).toEqual({
      previous: null,
      state: 'working'
    })
  })

  it('a no-op on the mapped state emits nothing: same word, and done↔idle', () => {
    expect(sessionStateTransition('working', 'working')).toBeNull()
    expect(sessionStateTransition('idle', 'done')).toBeNull()
    expect(sessionStateTransition('done', 'idle')).toBeNull()
  })
})
