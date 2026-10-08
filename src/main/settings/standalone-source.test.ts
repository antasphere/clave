import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSettingsPorts } from '../ports'
import { tempDataDir } from '../ports/testing'
import { standaloneSettingsSource } from './standalone-source'

/**
 * The standalone server owns the Antasphere login the way the shell does
 * (PRDCT-3259): the same manager on the standalone ports, restored from the
 * data directory, shut down with the server. Nothing here signs in, so no
 * Keychain is touched: the status read asks the port whether it is
 * available and files nothing.
 */
afterEach(() => resetSettingsPorts())

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
