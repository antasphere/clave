import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SERVER_NAME_FILE,
  defaultServerName,
  ownServerName,
  readStoredServerName,
  resolveServerName,
  writeStoredServerName
} from './server-name'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'server-name-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a server’s own name (PRDCT-4241)', () => {
  it('names a server after its hostname without .local, never with nothing', () => {
    expect(defaultServerName('MacStudio.local')).toBe('MacStudio')
    expect(defaultServerName('romains-macbook-pro2.home')).toBe('romains-macbook-pro2')
    expect(defaultServerName('.odd')).toBe('clave-server')
    expect(defaultServerName('')).toBe('clave-server')
  })

  it('the stored name wins over the flag, the flag over the environment, both over the hostname', () => {
    const hostname = 'box.local'
    expect(resolveServerName({ stored: null, hostname })).toBe('box')
    expect(resolveServerName({ stored: null, env: 'fromenv', hostname })).toBe('fromenv')
    expect(resolveServerName({ stored: null, flag: 'flagged', env: 'fromenv', hostname })).toBe(
      'flagged'
    )
    expect(resolveServerName({ stored: 'Studio', flag: 'flagged', env: 'fromenv', hostname })).toBe(
      'Studio'
    )
  })

  it('passes over a value the rule refuses: spaces, the reserved word, nothing', () => {
    const hostname = 'box'
    expect(resolveServerName({ stored: 'two words', hostname })).toBe('box')
    expect(resolveServerName({ stored: 'every', flag: 'ok-flag', hostname })).toBe('ok-flag')
    expect(resolveServerName({ stored: '   ', env: '', hostname })).toBe('box')
  })

  it('reads nothing from a missing, broken or invalid file', () => {
    expect(readStoredServerName(dir)).toBeNull()
    writeFileSync(join(dir, SERVER_NAME_FILE), '{not json')
    expect(readStoredServerName(dir)).toBeNull()
    writeFileSync(join(dir, SERVER_NAME_FILE), JSON.stringify({ name: 'not a name' }))
    expect(readStoredServerName(dir)).toBeNull()
  })

  it('writes the name atomically and refuses one the rule refuses', () => {
    writeStoredServerName(dir, 'Studio')
    expect(JSON.parse(readFileSync(join(dir, SERVER_NAME_FILE), 'utf8'))).toEqual({
      name: 'Studio'
    })
    expect(readStoredServerName(dir)).toBe('Studio')
    expect(() => writeStoredServerName(dir, 'every')).toThrow(/cannot name a server/)
    expect(() => writeStoredServerName(dir, 'a b')).toThrow(/cannot name a server/)
    expect(readStoredServerName(dir)).toBe('Studio')
  })

  it('answers the current name at each read, and the stored one after a set', () => {
    const own = ownServerName(join(dir, 'data'), { flag: 'flagged', hostname: 'box.local' })
    expect(own()).toBe('flagged')
    expect(own.set(' Studio ')).toBe('Studio')
    expect(own()).toBe('Studio')
    expect(readStoredServerName(join(dir, 'data'))).toBe('Studio')
    expect(() => own.set('every')).toThrow()
    expect(own()).toBe('Studio')
  })
})
