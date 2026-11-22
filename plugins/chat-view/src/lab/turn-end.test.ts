import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../../../src/shared/session-model'
import { NO_TURN, trackTurn, turnEndAction, turnRunning, type TurnTrack } from './turn-end'

const done = { status: 'done' as const, answer: 'The answer.' }
const base = {
  wasRunning: true,
  state: 'idle' as const,
  page: done,
  visible: true,
  active: true,
  on: true
}

describe('turnEndAction', () => {
  it('reads a finished answer on the page', () => {
    expect(turnEndAction(base)).toBe('read')
  })
  it('files it off the page, while the pane is the chosen view', () => {
    expect(turnEndAction({ ...base, visible: false })).toBe('file')
  })
  it('does nothing when the pane is not the chosen view', () => {
    expect(turnEndAction({ ...base, visible: false, active: false })).toBe('nothing')
  })
  it('does nothing with the play mode off', () => {
    expect(turnEndAction({ ...base, on: false })).toBe('nothing')
    expect(turnEndAction({ ...base, visible: false, on: false })).toBe('nothing')
  })
  it('does nothing without a turn seen running', () => {
    expect(turnEndAction({ ...base, wasRunning: false })).toBe('nothing')
  })
  it('does nothing while the turn runs', () => {
    expect(turnEndAction({ ...base, state: 'working' })).toBe('nothing')
    expect(turnEndAction({ ...base, state: 'blocked' })).toBe('nothing')
  })
  it('every rest counts: idle, done, ended', () => {
    for (const state of ['idle', 'done', 'ended'] as const)
      expect(turnEndAction({ ...base, state, visible: false })).toBe('file')
  })
  it('only a done page with words: interrupted, waiting or empty answers are nothing', () => {
    expect(turnEndAction({ ...base, page: { status: 'interrupted', answer: 'x' } })).toBe('nothing')
    expect(turnEndAction({ ...base, page: { status: 'waiting', answer: 'x' } })).toBe('nothing')
    expect(turnEndAction({ ...base, page: { status: 'done', answer: '  ' } })).toBe('nothing')
    expect(turnEndAction({ ...base, page: null })).toBe('nothing')
  })
  it('turnRunning', () => {
    expect(turnRunning('working')).toBe(true)
    expect(turnRunning('blocked')).toBe(true)
    expect(turnRunning('idle')).toBe(false)
  })
})

describe('turnEndAction never cuts a reading', () => {
  it('a visible page files its answer while the voice is busy', () => {
    expect(turnEndAction({ ...base, busy: true })).toBe('file')
  })
  it('a hidden page files as before', () => {
    expect(turnEndAction({ ...base, visible: false, busy: true })).toBe('file')
  })
})

/** The turns a batch of live events ends. */
function ends(events: SessionEvent[], start: TurnTrack = NO_TURN): number {
  let track = start
  let n = 0
  for (const event of events) {
    const next = trackTurn(track, event)
    track = next.track
    if (next.ended) n++
  }
  return n
}
const state = (s: 'working' | 'blocked' | 'done' | 'idle' | 'ended'): SessionEvent =>
  ({ type: 'state_change', state: s }) as SessionEvent
const text = (parent?: string): SessionEvent =>
  ({ type: 'assistant_text', text: 'x', ...(parent && { parent }) }) as unknown as SessionEvent

describe('trackTurn: a turn of the live stream', () => {
  it('a batch working, text, done ends one turn', () => {
    expect(ends([state('working'), text(), state('done')])).toBe(1)
  })
  it('text then done without working ends one', () => {
    expect(ends([text(), state('done')])).toBe(1)
  })
  it('idle ends it too, blocked runs it', () => {
    expect(ends([state('blocked'), state('idle')])).toBe(1)
  })
  it("a subagent's text then done ends none", () => {
    expect(ends([text('call-1'), state('done')])).toBe(0)
  })
  it('ended ends none, and resets', () => {
    expect(ends([state('working'), state('ended')])).toBe(0)
    expect(ends([state('working'), state('ended'), state('done')])).toBe(0)
  })
  it('a rest with nothing run ends none; two turns end two', () => {
    expect(ends([state('done')])).toBe(0)
    expect(ends([state('working'), state('done'), text(), state('idle')])).toBe(2)
  })
})
