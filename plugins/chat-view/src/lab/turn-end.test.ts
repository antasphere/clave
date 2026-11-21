import { describe, expect, it } from 'vitest'
import { turnEndAction, turnRunning } from './turn-end'

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
