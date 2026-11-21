import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, globalShortcut: {}, ipcMain: {} }))
vi.mock('./ipc-handlers/keymap-handlers', () => ({ getStoredKeymapConfig: () => null }))
vi.mock('./preferences-manager', () => ({ preferencesManager: { get: () => true } }))

import { resolveKeymapConfig } from '../shared/keymaps'
import { pickWindow, readStatus, updateAccelerators, type UpdatesStatus } from './updates-key'

const map = (entries: [number, UpdatesStatus][]): Map<number, UpdatesStatus> => new Map(entries)
const waiting = (at: number): UpdatesStatus => ({ active: true, playing: false, oldestAt: at })

describe('pickWindow', () => {
  it('a playing window wins', () => {
    expect(
      pickWindow(
        map([
          [1, waiting(10)],
          [2, { active: true, playing: true, oldestAt: null }]
        ])
      )
    ).toBe(2)
  })
  it('else the window with the oldest update', () => {
    expect(
      pickWindow(
        map([
          [1, waiting(30)],
          [2, waiting(10)],
          [3, waiting(20)]
        ])
      )
    ).toBe(2)
  })
  it('else none', () => {
    expect(pickWindow(map([]))).toBeNull()
    expect(pickWindow(map([[1, { active: false, playing: false, oldestAt: null }]]))).toBeNull()
  })
})

describe('updateAccelerators', () => {
  it('the default binding as the accelerator of each platform', () => {
    expect(updateAccelerators(resolveKeymapConfig(), 'darwin')).toEqual(['Control+Shift+Space'])
  })
  it('only single chords, no mouse, no sequence', () => {
    const config = resolveKeymapConfig({
      version: 1,
      bindings: { playUpdate: ['Master P', 'Mod+Shift+L'] }
    })
    expect(updateAccelerators(config, 'darwin')).toEqual(['Command+Shift+L'])
    expect(updateAccelerators(config, 'linux')).toEqual(['Super+Shift+L'])
  })
})

describe('readStatus', () => {
  it('reads a well-formed status and refuses anything else', () => {
    expect(readStatus({ active: true, playing: false, oldestAt: 5 })).toEqual(waiting(5))
    expect(readStatus({ active: true, playing: false })).toEqual({
      active: true,
      playing: false,
      oldestAt: null
    })
    expect(readStatus(null)).toBeNull()
    expect(readStatus({ active: 'yes' })).toBeNull()
  })
})
