import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usageManager } from '../usage-manager'
import { codexUsageManager } from '../codex-usage'
import { resetSettingsPorts } from '../ports'
import { tempDataDir } from '../ports/testing'
import { standaloneSettingsSource } from './standalone-source'
import { helperById, helperConfig, setHelperConfigSource } from '../helpers/registry'

/**
 * The standalone server owns the Antasphere login the way the shell does
 * (PRDCT-3259): the same manager on the standalone ports, restored from the
 * data directory, shut down with the server. Nothing here signs in, so no
 * Keychain is touched: the status read asks the port whether it is
 * available and files nothing.
 */
beforeEach(() => {
  vi.spyOn(usageManager, 'startPolling').mockImplementation(() => {})
  vi.spyOn(codexUsageManager, 'startPolling').mockImplementation(() => {})
})
afterEach(() => {
  resetSettingsPorts()
  vi.restoreAllMocks()
})

describe('the standalone settings source', () => {
  it('serves the Antasphere account from its own data directory, and can be shut down', async () => {
    const dir = tempDataDir('clave-standalone-source-')
    const { settings, shutdown } = standaloneSettingsSource(dir, {
      CLAVE_ANTASPHERE_ISSUER: 'http://127.0.0.1:1'
    })
    expect(settings.antasphere).toBeDefined()
    const status = await settings.antasphere.status()
    expect(status).toMatchObject({ phase: 'signed-out', account: null, issuerHost: '127.0.0.1:1' })
    expect(typeof shutdown).toBe('function')
    shutdown()
  })

  it('hands the devices port the very login its settings serve, read at once and heard on change (PRDCT-4448)', async () => {
    const dir = tempDataDir('clave-standalone-source-')
    const standalone = standaloneSettingsSource(dir, {
      CLAVE_ANTASPHERE_ISSUER: 'http://127.0.0.1:1'
    })
    try {
      // Synchronous: the phone's checks read it at the moment they decide. Nothing here
      // signs in or out, so no Keychain is touched.
      const status = standalone.antasphere.status()
      expect(status).toMatchObject({ phase: 'signed-out', account: null })
      const read = vi.spyOn(standalone.antasphere, 'status')
      expect(await standalone.settings.antasphere.status()).toEqual(status)
      expect(read).toHaveBeenCalledTimes(1)
      expect(typeof standalone.antasphere.onChange(() => {})).toBe('function')
    } finally {
      standalone.shutdown()
    }
  })
})

describe('the helpers on the standalone server (PRDCT-4330)', () => {
  it("the runner reads this server's preference, written through its settings source", async () => {
    const dir = tempDataDir('clave-standalone-helpers-')
    const { settings, shutdown } = standaloneSettingsSource(dir, {})
    try {
      const title = helperById('tab-title')!
      expect(helperConfig(title).enabled).toBe(true)
      await settings.helpers.set('tab-title', { enabled: false, model: 'sonnet' })
      expect(helperConfig(title)).toMatchObject({ enabled: false, model: 'sonnet' })
    } finally {
      shutdown()
      setHelperConfigSource()
    }
  })
})

describe('the standalone server’s stdout is the launcher’s protocol', () => {
  // `scripts/server-process.mjs` reads ONE JSON line off stdout, the first:
  // a diagnostic printed there first is an unreadable announcement and a
  // server that is killed before it serves. Every account diagnostic goes
  // to stderr, as the safe event name and fields the manager logs (codes,
  // never a token, a URL or the hub's text).
  it('an early account diagnostic reaches stderr and never stdout', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A refused issuer override: the manager logs `antasphere.config.refused`
      // in its constructor, before anything is served.
      const { shutdown } = standaloneSettingsSource(tempDataDir('clave-standalone-log-'), {
        CLAVE_ANTASPHERE_ISSUER: 'ftp://not-an-issuer'
      })
      shutdown()
      const text = (calls: unknown[][]): string =>
        calls
          .map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
          .join('\n')
      const stdout = text(out.mock.calls) + text(log.mock.calls)
      const stderr = text(err.mock.calls) + text(error.mock.calls)
      expect(stdout).not.toContain('antasphere')
      expect(stderr).toContain('antasphere.config.refused')
      expect(stderr).toMatch(/"reason":"plain http is only accepted for 127\.0\.0\.1"/)
      expect(stderr).not.toContain('ftp://')
    } finally {
      out.mockRestore()
      err.mockRestore()
      log.mockRestore()
      error.mockRestore()
    }
  })
})

describe('the standalone usage clock', () => {
  it('starts both provider clocks and stops them with the server', () => {
    const startClaude = vi.spyOn(usageManager, 'startPolling').mockImplementation(() => {})
    const startCodex = vi.spyOn(codexUsageManager, 'startPolling').mockImplementation(() => {})
    const stopClaude = vi.spyOn(usageManager, 'stopPolling')
    const stopCodex = vi.spyOn(codexUsageManager, 'stopPolling')
    try {
      const { shutdown } = standaloneSettingsSource(tempDataDir('clave-usage-clock-'))
      expect(startClaude).toHaveBeenCalledOnce()
      expect(startCodex).toHaveBeenCalledOnce()
      shutdown()
      expect(stopClaude).toHaveBeenCalledOnce()
      expect(stopCodex).toHaveBeenCalledOnce()
    } finally {
      vi.restoreAllMocks()
    }
  })
})
