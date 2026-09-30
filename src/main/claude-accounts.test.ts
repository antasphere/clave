import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-accounts-'))
let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    // A reversible stand-in: the point is that what lands on disk is not the
    // token, and that only this process can turn it back.
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
  }
}))

import { claudeAccountsManager, isPlausibleOauthToken } from './claude-accounts'

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789'

beforeEach(() => {
  encryptionAvailable = true
  for (const account of claudeAccountsManager.list()) {
    if (account.id !== 'default') claudeAccountsManager.remove(account.id)
  }
})

describe('the account list', () => {
  it('always starts with the Default, the machine login', () => {
    expect(claudeAccountsManager.list()[0]).toMatchObject({
      id: 'default',
      hasToken: false,
      tokenInvalid: false
    })
  })

  it('keeps the pool in the order given; the Default stays first', () => {
    const a = claudeAccountsManager.add({ label: 'A' })
    const b = claudeAccountsManager.add({ label: 'B' })
    const c = claudeAccountsManager.add({ label: 'C' })
    claudeAccountsManager.reorder([c.id, a.id])
    expect(claudeAccountsManager.list().map((x) => x.id)).toEqual(['default', c.id, a.id, b.id])
    claudeAccountsManager.reorder(['default', 'nobody', b.id])
    expect(claudeAccountsManager.list().map((x) => x.id)).toEqual(['default', b.id, c.id, a.id])
  })

  it('adds, renames, resolves by id or name, and removes', () => {
    const work = claudeAccountsManager.add({ label: 'Work' })
    expect(claudeAccountsManager.resolve('Work')?.id).toBe(work.id)
    expect(claudeAccountsManager.resolve('work')?.id).toBe(work.id)
    expect(claudeAccountsManager.resolve(work.id)?.label).toBe('Work')
    claudeAccountsManager.update(work.id, { label: 'Work (Max)' })
    expect(claudeAccountsManager.get(work.id)?.label).toBe('Work (Max)')
    expect(claudeAccountsManager.remove(work.id)).toBe(true)
    expect(claudeAccountsManager.resolve('Work (Max)')).toBeUndefined()
  })

  it('does not resolve an ambiguous name', () => {
    claudeAccountsManager.add({ label: 'Twin' })
    claudeAccountsManager.add({ label: 'twin' })
    expect(claudeAccountsManager.resolve('Twin')?.label).toBe('Twin')
    expect(claudeAccountsManager.resolve('TWIN')).toBeUndefined()
  })

  it('never removes or renames the Default', () => {
    expect(claudeAccountsManager.remove('default')).toBe(false)
    expect(claudeAccountsManager.update('default', { label: 'x' })?.label).toBe('Default')
  })

  it('survives a reload from disk', () => {
    const work = claudeAccountsManager.add({ label: 'Persisted' })
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'claude-accounts.json'), 'utf-8'))
    expect(raw.accounts).toEqual([{ id: work.id, label: 'Persisted' }])
  })
})

/**
 * The config-dir shape is retired (ADR 0002): an account that carried a
 * directory keeps its label and is asked to sign in again. Read through a
 * fresh manager on a file the previous build wrote.
 */
describe('the migration of config-dir accounts', () => {
  it('drops the directory, keeps the account, names it as needing a login, and writes back', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-accounts-migrate-'))
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
    vi.doMock('electron', () => ({
      app: { getPath: () => other },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(`enc:${value}`),
        decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
      }
    }))
    vi.resetModules()
    const fresh = (await import('./claude-accounts')).claudeAccountsManager
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
    vi.doUnmock('electron')
    vi.resetModules()
  })
})

describe('the tokens', () => {
  it('stores a token encrypted, reports it, and hands it back only in main', () => {
    const work = claudeAccountsManager.add({ label: 'Work' })
    claudeAccountsManager.setToken(work.id, `  ${TOKEN}\n`)
    expect(claudeAccountsManager.get(work.id)?.hasToken).toBe(true)
    expect(claudeAccountsManager.getToken(work.id)).toBe(TOKEN)
    const onDisk = fs.readFileSync(path.join(dir, 'claude-accounts-credentials.json'), 'utf-8')
    expect(onDisk).not.toContain(TOKEN)
    expect(JSON.stringify(claudeAccountsManager.list())).not.toContain(TOKEN)
  })

  it('refuses a value that is not a token, and the Default account', () => {
    const work = claudeAccountsManager.add({ label: 'Work' })
    expect(() => claudeAccountsManager.setToken(work.id, 'hello')).toThrow(/does not look like/)
    expect(() => claudeAccountsManager.setToken('default', TOKEN)).toThrow(/Default/)
    expect(claudeAccountsManager.hasToken(work.id)).toBe(false)
  })

  it('never falls back to plaintext when the OS cannot encrypt', () => {
    const work = claudeAccountsManager.add({ label: 'Work' })
    encryptionAvailable = false
    expect(() => claudeAccountsManager.setToken(work.id, TOKEN)).toThrow(/encryption/)
    expect(claudeAccountsManager.hasToken(work.id)).toBe(false)
  })

  it('dates the token, assumes a year of life, and marks a refused one dead until the next', () => {
    const work = claudeAccountsManager.add({ label: 'Work' })
    const before = Date.now()
    claudeAccountsManager.setToken(work.id, TOKEN)
    const account = claudeAccountsManager.get(work.id)!
    expect(account.tokenSetAt).toBeGreaterThanOrEqual(before)
    expect(account.tokenExpiresAt).toBe(account.tokenSetAt! + 365 * 24 * 3600 * 1000)
    expect(account.tokenInvalid).toBe(false)
    claudeAccountsManager.markTokenInvalid(work.id)
    expect(claudeAccountsManager.get(work.id)?.tokenInvalid).toBe(true)
    // Still held: the user sees which account died, and can still spawn on it.
    expect(claudeAccountsManager.getToken(work.id)).toBe(TOKEN)
    claudeAccountsManager.setToken(work.id, TOKEN + 'x')
    expect(claudeAccountsManager.get(work.id)?.tokenInvalid).toBe(false)
    // Nothing to mark on an account without a token.
    const bare = claudeAccountsManager.add({ label: 'Bare' })
    claudeAccountsManager.markTokenInvalid(bare.id)
    expect(claudeAccountsManager.get(bare.id)?.tokenInvalid).toBe(false)
  })

  it('forgets the token with the account, and on clear', () => {
    const work = claudeAccountsManager.add({ label: 'Work' })
    claudeAccountsManager.setToken(work.id, TOKEN)
    claudeAccountsManager.clearToken(work.id)
    expect(claudeAccountsManager.getToken(work.id)).toBeUndefined()
    claudeAccountsManager.setToken(work.id, TOKEN)
    claudeAccountsManager.remove(work.id)
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, 'claude-accounts-credentials.json'), 'utf-8')
    )
    expect(onDisk[work.id]).toBeUndefined()
  })

  it('tells listeners on every change', () => {
    const seen: number[] = []
    const off = claudeAccountsManager.onChange((list) => seen.push(list.length))
    const work = claudeAccountsManager.add({ label: 'Work' })
    claudeAccountsManager.setToken(work.id, TOKEN)
    claudeAccountsManager.remove(work.id)
    off()
    expect(seen).toEqual([2, 2, 1])
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
