import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The standalone server's plugin service over its data directory (test mode
// keeps the plugins under it, as the app keeps its own under user data): a
// registry it cannot read degrades to a refusing service, the shell's own
// way, instead of ending the entry at boot.
vi.mock('../test-mode', () => ({ TEST_NO_ACTIVATE: true, OWN_PROFILE: false }))
import { standalonePlugins } from './standalone-plugins'

let temporary: string
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  temporary = mkdtempSync(join(tmpdir(), 'clave-standalone-plugins-'))
  mkdirSync(join(temporary, 'bundled'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(temporary, { recursive: true, force: true })
})

describe('the standalone server’s plugins', () => {
  it('keeps the plugins under the data directory and lists an empty bundled folder as none', () => {
    const service = standalonePlugins({
      dataDir: temporary,
      bundled: join(temporary, 'bundled'),
      version: '1.90.2'
    })
    expect(service.list()).toEqual([])
    expect(service.store.root).toBe(join(temporary, 'clave-plugins'))
    service.close()
  })
  it('refuses every call with the sentence when installed.json cannot be read, instead of dying', () => {
    mkdirSync(join(temporary, 'clave-plugins'))
    writeFileSync(
      join(temporary, 'clave-plugins', 'installed.json'),
      JSON.stringify([{ id: 'x', source: 'link', enabled: true, permissionsGranted: ['root'] }])
    )
    const service = standalonePlugins({
      dataDir: temporary,
      bundled: join(temporary, 'bundled'),
      version: '1.90.2'
    })
    expect(() => service.list()).toThrow(/^Plugin registry could not be read: /)
    expect(() => service.leaseView('x', 'v', 's')).toThrow('Plugin registry could not be read')
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^clave-server: Plugin registry could not be read: /)
    )
    service.close()
  })
})
