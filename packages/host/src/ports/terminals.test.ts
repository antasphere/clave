import { afterEach, describe, it, expect } from 'vitest'
import { installSettingsPorts, resetSettingsPorts } from './registry'
import { fileStorage } from './storage'
import { electronTestPorts, tempDataDir } from './testing'
import {
  installTerminalPorts,
  lazyTerminalPorts,
  resetTerminalPorts,
  terminalPorts
} from './terminals'

afterEach(() => {
  resetTerminalPorts()
  resetSettingsPorts()
})

describe('the terminal ports registry', () => {
  it('refuses to write an MCP config before the app wired its server in, with the fix named', () => {
    expect(() => terminalPorts().mcpConfig.write('s1')).toThrow(
      /installTerminalPorts\(\{ mcpConfig \}\)/
    )
    // A close must never throw on the way out, wired or not.
    expect(() => terminalPorts().mcpConfig.remove('s1')).not.toThrow()
  })

  it('takes the settings ports’ storage when none of its own is named', () => {
    const settings = electronTestPorts(tempDataDir())
    installSettingsPorts(settings)
    expect(terminalPorts().storage.pathOf('x')).toBe(settings.storage.pathOf('x'))
    const own = fileStorage(tempDataDir())
    installTerminalPorts({ storage: own })
    expect(terminalPorts().storage.pathOf('x')).toBe(own.pathOf('x'))
  })

  it('keeps what was installed before when a later install names only one port', () => {
    const storage = fileStorage(tempDataDir())
    const mcpConfig = { write: () => '/cfg.json', remove: () => {} }
    installTerminalPorts({ storage })
    installTerminalPorts({ mcpConfig })
    expect(terminalPorts().storage).toBe(storage)
    expect(terminalPorts().mcpConfig).toBe(mcpConfig)
  })

  it('resolves lazily: the ports installed after a module loaded are the ones it uses', () => {
    const a = fileStorage(tempDataDir())
    const b = fileStorage(tempDataDir())
    installTerminalPorts({ storage: a })
    expect(lazyTerminalPorts.storage).toBe(a)
    installTerminalPorts({ storage: b })
    expect(lazyTerminalPorts.storage).toBe(b)
  })

  it('spawns through node-pty by default, one adapter for the process', () => {
    expect(terminalPorts().terminals).toBe(terminalPorts().terminals)
    expect(typeof terminalPorts().terminals.spawn).toBe('function')
  })
})
