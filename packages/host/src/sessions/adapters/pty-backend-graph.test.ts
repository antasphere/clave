import { describe, it, expect, vi } from 'vitest'
import { installSettingsPorts } from '../../ports/registry'
import { installTerminalPorts } from '../../ports/terminals'
import { fileStorage } from '../../ports/storage'
import { electronTestPorts, tempDataDir } from '../../ports/testing'

// Electron is not merely mocked away: asking for it fails the import. The
// terminal layer must load without it, which is the whole point of PRDCT-3240
// (a server of its own has no Electron to ask). The one edge left, the lazy
// `require('electron')` in the settings registry, is never taken once the
// ports are named, which this test does first.
vi.mock('electron', () => {
  throw new Error('the terminal layer imported electron')
})
vi.mock('node-pty', () => {
  throw new Error('the terminal layer loaded node-pty at import time')
})

describe('the terminal layer without Electron', () => {
  it('loads the backend, the adapter, the agent state manager and the records index', async () => {
    const dir = tempDataDir()
    installSettingsPorts(electronTestPorts(dir))
    installTerminalPorts({ storage: fileStorage(dir) })
    const backend = await import('./pty-backend')
    const adapter = await import('./pty-adapter')
    const state = await import('../../agent-state-manager')
    const index = await import('../../session-records-index')
    expect(typeof backend.ptyBackend.spawn).toBe('function')
    expect(adapter.ptyAdapter.id).toBe('pty')
    expect(state.stateFilePath('x')).toContain(dir)
    expect(index.sessionWorkspaceResolver()('nobody')).toBeNull()
  })
})
