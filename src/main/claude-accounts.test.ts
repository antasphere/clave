import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

import { ClaudeAccountsManager, isPlausibleOauthToken } from './claude-accounts'
import { eachTestPorts, electronTestPorts, standaloneTestPorts, tempDataDir } from './ports/testing'

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789'

describe.each(eachTestPorts())('on %s', (_name, makePorts) => {
  const ports = makePorts()
  const manager = new ClaudeAccountsManager(ports)
  const standalone = _name === 'the standalone adapters'
  /** Ports of the same shape as this suite's, on another directory. */
  const freshPorts = (dir: string): ReturnType<typeof makePorts> =>
    standalone ? standaloneTestPorts(dir) : electronTestPorts(dir)
  const security = (): ReturnType<typeof standaloneTestPorts>['security'] =>
    (ports as ReturnType<typeof standaloneTestPorts>).security
  const credentialsPath = (): string => path.join(ports.dir, 'claude-accounts-credentials.json')

  beforeEach(() => {
    for (const account of manager.list()) {
      if (account.id !== 'default') manager.remove(account.id)
    }
  })

  describe('the account list', () => {
    it('always starts with the Default, the machine login', () => {
      expect(manager.list()[0]).toMatchObject({
        id: 'default',
        hasToken: false,
        tokenInvalid: false
      })
    })

    it('keeps the pool in the order given; the Default stays first', () => {
      const a = manager.add({ label: 'A' })
      const b = manager.add({ label: 'B' })
      const c = manager.add({ label: 'C' })
      manager.reorder([c.id, a.id])
      expect(manager.list().map((x) => x.id)).toEqual(['default', c.id, a.id, b.id])
      manager.reorder(['default', 'nobody', b.id])
      expect(manager.list().map((x) => x.id)).toEqual(['default', b.id, c.id, a.id])
    })

    it('adds, renames, resolves by id or name, and removes', () => {
      const work = manager.add({ label: 'Work' })
      expect(manager.resolve('Work')?.id).toBe(work.id)
      expect(manager.resolve('work')?.id).toBe(work.id)
      expect(manager.resolve(work.id)?.label).toBe('Work')
      manager.update(work.id, { label: 'Work (Max)' })
      expect(manager.get(work.id)?.label).toBe('Work (Max)')
      expect(manager.remove(work.id)).toBe(true)
      expect(manager.resolve('Work (Max)')).toBeUndefined()
    })

    it('does not resolve an ambiguous name', () => {
      manager.add({ label: 'Twin' })
      manager.add({ label: 'twin' })
      expect(manager.resolve('Twin')?.label).toBe('Twin')
      expect(manager.resolve('TWIN')).toBeUndefined()
    })

    it('never removes or renames the Default', () => {
      expect(manager.remove('default')).toBe(false)
      expect(manager.update('default', { label: 'x' })?.label).toBe('Default')
    })

    it('survives a reload from disk', () => {
      const work = manager.add({ label: 'Persisted' })
      const raw = JSON.parse(fs.readFileSync(path.join(ports.dir, 'claude-accounts.json'), 'utf-8'))
      expect(raw.accounts).toEqual([{ id: work.id, label: 'Persisted' }])
    })
  })

  /**
   * The config-dir shape is retired (ADR 0002): an account that carried a
   * directory keeps its label and is asked to sign in again. Read through a
   * fresh manager on a file the previous build wrote.
   */
  describe('the migration of config-dir accounts', () => {
    it('drops the directory, keeps the account, names it as needing a login, and writes back', () => {
      const other = tempDataDir('clave-accounts-migrate-')
      fs.writeFileSync(
        path.join(other, 'claude-accounts.json'),
        JSON.stringify({
          v: 1,
          accounts: [
            { id: 'dir-1', label: 'Old dir', configDir: '/Users/x/.claude-work' },
            { id: 'tok-1', label: 'Token one', configDir: '' }
          ]
        })
      )
      const fresh = new ClaudeAccountsManager(freshPorts(other))
      expect(fresh.list().map((a) => [a.id, a.label, a.hasToken])).toEqual([
        ['default', 'Default', false],
        ['dir-1', 'Old dir', false],
        ['tok-1', 'Token one', false]
      ])
      expect(fresh.migratedAccountIds()).toEqual(['dir-1'])
      const raw = JSON.parse(fs.readFileSync(path.join(other, 'claude-accounts.json'), 'utf-8'))
      expect(raw.accounts).toEqual([
        { id: 'dir-1', label: 'Old dir' },
        { id: 'tok-1', label: 'Token one' }
      ])
      // A token lands: the account is a token account like any other.
      fresh.setToken('dir-1', TOKEN)
      expect(fresh.migratedAccountIds()).toEqual([])
    })
  })

  describe('the tokens', () => {
    it('stores a token encrypted, reports it, and hands it back only in main', () => {
      const work = manager.add({ label: 'Work' })
      manager.setToken(work.id, `  ${TOKEN}\n`)
      expect(manager.get(work.id)?.hasToken).toBe(true)
      expect(manager.getToken(work.id)).toBe(TOKEN)
      const onDisk = fs.readFileSync(credentialsPath(), 'utf-8')
      expect(onDisk).not.toContain(TOKEN)
      expect(JSON.stringify(manager.list())).not.toContain(TOKEN)
    })

    it('the file holds what the port handed back, never the value', () => {
      const work = manager.add({ label: 'Work' })
      manager.setToken(work.id, TOKEN)
      const stored = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'))[work.id].token
      expect(typeof stored).toBe('string')
      expect(stored).not.toBe(TOKEN)
      if (standalone) {
        expect(stored.startsWith('keychain:')).toBe(true)
        expect([...security().items.values()]).toEqual([TOKEN])
      } else {
        expect(stored).toBe(Buffer.from(`enc:${TOKEN}`).toString('base64'))
      }
    })

    it('a token sealed by the other adapter opens to nothing', () => {
      const work = manager.add({ label: 'Work' })
      fs.writeFileSync(
        credentialsPath(),
        JSON.stringify({ [work.id]: { token: 'not-this-adapters', setAt: 1 } })
      )
      const fresh = new ClaudeAccountsManager(ports)
      expect(fresh.hasToken(work.id)).toBe(true)
      expect(fresh.getToken(work.id)).toBeUndefined()
      expect(JSON.stringify(fresh.list())).not.toContain('not-this-adapters')
    })

    it.runIf(standalone)(
      'replacing or clearing a token forgets the old one in the secret store',
      () => {
        const items = security().items
        expect(items.size).toBe(0)
        const work = manager.add({ label: 'Work' })
        manager.setToken(work.id, TOKEN)
        manager.setToken(work.id, TOKEN + 'x')
        expect([...items.values()]).toEqual([TOKEN + 'x'])
        manager.clearToken(work.id)
        expect(items.size).toBe(0)
        manager.setToken(work.id, TOKEN)
        expect(items.size).toBe(1)
        manager.remove(work.id)
        expect(items.size).toBe(0)
      }
    )

    it('refuses a value that is not a token, and the Default account', () => {
      const work = manager.add({ label: 'Work' })
      expect(() => manager.setToken(work.id, 'hello')).toThrow(/does not look like/)
      expect(() => manager.setToken('default', TOKEN)).toThrow(/Default/)
      expect(manager.hasToken(work.id)).toBe(false)
    })

    it('never falls back to plaintext when the OS cannot encrypt', () => {
      const work = manager.add({ label: 'Work' })
      const locked = new ClaudeAccountsManager({
        ...ports,
        secrets: { ...ports.secrets, available: () => false }
      })
      expect(() => locked.setToken(work.id, TOKEN)).toThrow(/encryption/)
      expect(locked.hasToken(work.id)).toBe(false)
      expect(manager.hasToken(work.id)).toBe(false)
    })

    it('dates the token, assumes a year of life, and marks a refused one dead until the next', () => {
      const work = manager.add({ label: 'Work' })
      const before = Date.now()
      manager.setToken(work.id, TOKEN)
      const account = manager.get(work.id)!
      expect(account.tokenSetAt).toBeGreaterThanOrEqual(before)
      expect(account.tokenExpiresAt).toBe(account.tokenSetAt! + 365 * 24 * 3600 * 1000)
      expect(account.tokenInvalid).toBe(false)
      manager.markTokenInvalid(work.id)
      expect(manager.get(work.id)?.tokenInvalid).toBe(true)
      // Still held: the user sees which account died, and can still spawn on it.
      expect(manager.getToken(work.id)).toBe(TOKEN)
      manager.setToken(work.id, TOKEN + 'x')
      expect(manager.get(work.id)?.tokenInvalid).toBe(false)
      // Nothing to mark on an account without a token.
      const bare = manager.add({ label: 'Bare' })
      manager.markTokenInvalid(bare.id)
      expect(manager.get(bare.id)?.tokenInvalid).toBe(false)
    })

    it('forgets the token with the account, and on clear', () => {
      const work = manager.add({ label: 'Work' })
      manager.setToken(work.id, TOKEN)
      manager.clearToken(work.id)
      expect(manager.getToken(work.id)).toBeUndefined()
      manager.setToken(work.id, TOKEN)
      manager.remove(work.id)
      const onDisk = JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8'))
      expect(onDisk[work.id]).toBeUndefined()
    })

    it('tells listeners on every change', () => {
      const seen: number[] = []
      const off = manager.onChange((list) => seen.push(list.length))
      const work = manager.add({ label: 'Work' })
      manager.setToken(work.id, TOKEN)
      manager.remove(work.id)
      off()
      expect(seen).toEqual([2, 2, 1])
    })
  })
})

describe('isPlausibleOauthToken', () => {
  it('accepts what setup-token prints and refuses the rest', () => {
    expect(isPlausibleOauthToken(TOKEN)).toBe(true)
    expect(isPlausibleOauthToken('sk-ant-api03-' + 'x'.repeat(30))).toBe(true)
    expect(isPlausibleOauthToken('')).toBe(false)
    expect(isPlausibleOauthToken('sk-ant-short')).toBe(false)
    expect(isPlausibleOauthToken('ghp_' + 'x'.repeat(40))).toBe(false)
  })
})
