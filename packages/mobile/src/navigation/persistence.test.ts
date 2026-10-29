import { describe, expect, it } from 'vitest'
import {
  RESTORE_WINDOW_MS,
  decideInitialNavigation,
  freshState,
  machineIdOf,
  parseSaved
} from './persistence'

const chat = {
  index: 3,
  routes: [
    { name: 'Machines' },
    { name: 'Workspaces', params: { machineId: 'm1' } },
    { name: 'Sessions', params: { machineId: 'm1', workspaceId: 'w1' } },
    { name: 'Chat', params: { machineId: 'm1', sessionId: 's1' } }
  ]
}

describe('where the app opens', () => {
  it("a fresh launch opens Machines then the last machine's Workspaces", () => {
    expect(decideInitialNavigation(null, 1_000, 'm1')).toEqual({
      kind: 'fresh',
      state: freshState('m1')
    })
    expect(freshState('m1')).toEqual({
      index: 1,
      routes: [{ name: 'Machines' }, { name: 'Workspaces', params: { machineId: 'm1' } }]
    })
    expect(freshState(null)).toEqual({ index: 0, routes: [{ name: 'Machines' }] })
  })
  it('a return within the window restores the open conversation', () => {
    const saved = { state: chat, savedAt: 10_000, machineId: 'm1' }
    expect(decideInitialNavigation(saved, 10_000 + RESTORE_WINDOW_MS - 1, 'm1')).toEqual({
      kind: 'restore',
      state: chat
    })
  })
  it('a save older than the window, or from the future, is a fresh launch', () => {
    const saved = { state: chat, savedAt: 10_000, machineId: 'm1' }
    expect(decideInitialNavigation(saved, 10_000 + RESTORE_WINDOW_MS, 'm1').kind).toBe('fresh')
    expect(decideInitialNavigation(saved, 9_000, 'm1').kind).toBe('fresh')
  })
  it('reads a save back and tolerates junk', () => {
    expect(parseSaved(null)).toBeNull()
    expect(parseSaved('{not json')).toBeNull()
    expect(parseSaved(JSON.stringify({ savedAt: 'yesterday', state: {} }))).toBeNull()
    expect(parseSaved(JSON.stringify({ savedAt: 5, state: chat, machineId: 'm1' }))).toEqual({
      savedAt: 5,
      state: chat,
      machineId: 'm1'
    })
  })
  it('names the machine of a screen tree', () => {
    expect(machineIdOf(chat)).toBe('m1')
    expect(machineIdOf(freshState(null))).toBeNull()
    expect(machineIdOf(null)).toBeNull()
  })
})
