import { describe, expect, it } from 'vitest'
import { finishesTurn } from './turn-state'
import { finishesTurn as rendererFinishesTurn } from '../renderer/src/lib/tab-status'

/** The turn-end rule (PRDCT-4472): one rule for the sidebar and the server. */
describe('a finished turn', () => {
  it('is a running or waiting turn that comes to rest', () => {
    expect(finishesTurn('working', 'done')).toBe(true)
    expect(finishesTurn('working', 'idle')).toBe(true)
    expect(finishesTurn('blocked', 'done')).toBe(true)
    expect(finishesTurn('blocked', 'idle')).toBe(true)
  })

  it('is not a first state, a rest after a rest, a turn still running or an end', () => {
    expect(finishesTurn(undefined, 'done')).toBe(false)
    expect(finishesTurn('idle', 'done')).toBe(false)
    expect(finishesTurn('done', 'idle')).toBe(false)
    expect(finishesTurn('working', 'blocked')).toBe(false)
    expect(finishesTurn('working', 'ended')).toBe(false)
  })

  it('is the same function the renderer imports', () => {
    expect(rendererFinishesTurn).toBe(finishesTurn)
  })
})
