import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { installSettingsPorts, resetSettingsPorts } from '../ports/registry'
import { resetTerminalPorts, terminalPorts } from '../ports/terminals'
import { electronTestPorts, tempDataDir } from '../ports/testing'

// The standalone host runs where no Electron is: asking for it fails the
// import. Test mode is on, as the harness starts the server.
vi.mock('electron', () => {
  throw new Error('the standalone host imported electron')
})
vi.mock('node-pty', () => {
  throw new Error('the standalone host loaded node-pty at import time')
})
vi.mock('../test-mode', () => ({ TEST_NO_ACTIVATE: true }))

type Hooked = typeof globalThis & { __claveE2E?: { sessionHost?: unknown } }

afterEach(() => {
  delete (globalThis as Hooked).__claveE2E
  resetTerminalPorts()
  resetSettingsPorts()
})

describe('the standalone server’s session host', () => {
  it('is the app’s own host on the server’s ports: its folder, its terminals, no MCP server, on the hooks', async () => {
    const dir = tempDataDir()
    installSettingsPorts(electronTestPorts(dir))
    const terminals = {
      spawn: () => {
        throw new CapabilityUnavailable({ capability: 'terminals', message: 'none here' })
      }
    }
    const { standaloneSessionHost } = await import('./standalone-host')
    const { getSessionHost } = await import('./host')
    const { host, agentTools } = standaloneSessionHost({ dataDir: dir, terminals })
    expect(host).toBe(getSessionHost())
    expect(typeof agentTools.resolve).toBe('function')
    // The end-to-end seam finds the host where it finds the app's.
    expect((globalThis as Hooked).__claveE2E?.sessionHost).toBe(host)
    const ports = terminalPorts()
    expect(ports.terminals).toBe(terminals)
    // No announced address yet: a Claude session starts without --mcp-config
    // rather than refusing to start (the shell announces it with
    // AnnounceAgentTools; agent-tokens.test.ts pins the write once it has).
    expect(ports.mcpConfig.write('session-1')).toBeNull()
    expect(() => ports.mcpConfig.remove('session-1')).not.toThrow()
    // The terminal layer's documents live under the server's folder.
    expect(ports.storage.pathOf('terminal-journal.jsonl')).toContain(dir)
  })
})
