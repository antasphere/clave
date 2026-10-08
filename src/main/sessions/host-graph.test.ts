import { describe, it, expect, vi } from 'vitest'
import { installSettingsPorts } from '../ports/registry'
import { installTerminalPorts } from '../ports/terminals'
import { fileStorage } from '../ports/storage'
import { electronTestPorts, tempDataDir } from '../ports/testing'

// The session host must load without Electron (PRDCT-3293): the standalone
// server builds the same host over the same manager and lifecycle, and it
// has no Electron to ask. Asking for it fails the import, so a chain that
// comes back (a window object in the lifecycle, the clipboard in the copy
// offer, the MCP runtime in the Claude adapter, the window registry in the
// title generator) fails this test rather than the standalone server.
vi.mock('electron', () => {
  throw new Error('the session host imported electron')
})
vi.mock('node-pty', () => {
  throw new Error('the session host loaded node-pty at import time')
})

describe('the session host without Electron', () => {
  it('loads the host, the lifecycle, the title generator and the copy offer', async () => {
    const dir = tempDataDir()
    installSettingsPorts(electronTestPorts(dir))
    installTerminalPorts({ storage: fileStorage(dir) })
    const host = await import('./host')
    const lifecycle = await import('./lifecycle')
    const titles = await import('../title-generator')
    const offers = await import('../copy-offer-manager')
    const events = await import('../server/session-events')
    expect(typeof host.createSessionHost).toBe('function')
    expect(typeof host.getSessionHost().start).toBe('function')
    expect(typeof lifecycle.spawnSession).toBe('function')
    expect(typeof titles.scheduleTitleGeneration).toBe('function')
    expect(typeof offers.createOffer).toBe('function')
    expect(events.hasServerEventPublisher()).toBe(false)
  })
})
