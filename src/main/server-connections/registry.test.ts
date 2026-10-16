import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStorage } from '../ports/storage'
import type { SettingsPorts } from '../ports/registry'
import { ServerConnectionRegistry } from './registry'

describe('saved server connection registry', () => {
  let dir: string
  let ports: SettingsPorts
  let registry: ServerConnectionRegistry
  const secret = 'private-bearer-do-not-publish'
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clave-vps-a-registry-'))
    const values = new Map<string, string>()
    let next = 0
    ports = {
      storage: fileStorage(dir),
      secrets: {
        available: () => true,
        seal: vi.fn((plain) => {
          const key = `sealed-${++next}`
          values.set(key, plain)
          return key
        }),
        open: (key) => values.get(key),
        discard: vi.fn((key) => {
          values.delete(key)
        })
      }
    }
    let id = 0
    registry = new ServerConnectionRegistry(ports, () => `server-${++id}`)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const input = (): { name: string; url: string; token: string } => ({
    name: 'My VPS',
    url: 'http://100.64.0.1:8123',
    token: secret
  })

  it('persists stable identity and only sealed references, returning secret-free DTOs', () => {
    const a = registry.save(input())
    const b = registry.save({ ...input(), name: 'Second VPS' })
    expect(a.id).not.toBe(b.id)
    expect(registry.list()).toEqual([a, b])
    const text = readFileSync(join(dir, 'server-connections.json'), 'utf8')
    expect(text).not.toContain(secret)
    expect(text).toContain('sealed-1')
    expect(statSync(join(dir, 'server-connections.json')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(registry.list())).not.toMatch(/token|credential|sealed-/)
    const reload = new ServerConnectionRegistry(ports)
    expect(reload.list()).toEqual([a, b])
    expect(reload.endpoint(a.id)).toEqual({ url: a.url, token: secret })
    expect(registry.save({ id: a.id, name: 'Renamed', url: 'https://vps.tailnet.test' }).id).toBe(
      a.id
    )
  })
  it('distinguishes disabling from removal and preserves credentials across reconnect', () => {
    const a = registry.save(input())
    expect(registry.disconnect(a.id).enabled).toBe(false)
    expect(() => registry.endpoint(a.id)).toThrow(/disconnected/i)
    expect(new ServerConnectionRegistry(ports).list()[0].enabled).toBe(false)
    expect(registry.connect(a.id).enabled).toBe(true)
    expect(registry.endpoint(a.id).token).toBe(secret)
    expect(ports.secrets.discard).not.toHaveBeenCalled()
    registry.remove(a.id)
    expect(registry.list()).toEqual([])
    expect(ports.secrets.discard).toHaveBeenCalledWith('sealed-1')
    expect(() => registry.endpoint(a.id)).toThrow(/unknown/i)
  })
  it('rotates a credential only after successful persistence', () => {
    const a = registry.save(input())
    const originalWrite = ports.storage.write
    ports.storage.write = () => {
      throw new Error('disk full')
    }
    expect(() => registry.save({ ...input(), id: a.id, token: 'replacement' })).toThrow(/save/i)
    expect(registry.endpoint(a.id).token).toBe(secret)
    expect(ports.secrets.discard).toHaveBeenCalledWith('sealed-2')
    expect(ports.secrets.discard).not.toHaveBeenCalledWith('sealed-1')
    ports.storage.write = originalWrite
    registry.save({ ...input(), id: a.id, token: 'replacement' })
    expect(registry.endpoint(a.id).token).toBe('replacement')
    expect(ports.secrets.discard).toHaveBeenCalledWith('sealed-1')
  })
  it('does not forget a credential or mutate state when remove/disable persistence fails', () => {
    const a = registry.save(input())
    ports.storage.write = () => {
      throw new Error('disk full')
    }
    expect(() => registry.remove(a.id)).toThrow()
    expect(() => registry.disconnect(a.id)).toThrow()
    expect(registry.list()).toEqual([a])
    expect(registry.endpoint(a.id).token).toBe(secret)
    expect(ports.secrets.discard).not.toHaveBeenCalled()
  })
  it('fails closed when encryption or credentials are unavailable', () => {
    ports.secrets.available = () => false
    expect(() => registry.save(input())).toThrow(/secure/i)
    expect(registry.list()).toEqual([])
    ports.secrets.available = () => true
    const a = registry.save(input())
    ports.secrets.open = () => undefined
    expect(() => registry.endpoint(a.id)).toThrow(/credential/i)
  })
  it('validates untrusted shape, URLs and token bounds without disclosing input', () => {
    for (const bad of [
      null,
      {},
      { ...input(), name: '' },
      { ...input(), url: 'file:///etc/passwd' },
      { ...input(), url: 'http://user:pass@host' },
      { ...input(), url: 'http://host/?token=secret' },
      { ...input(), url: 'http://host/#secret' },
      { ...input(), url: 'http://host/path' },
      { ...input(), token: '' },
      { ...input(), token: 'line\nbreak' },
      { ...input(), token: 'x'.repeat(8193) },
      { ...input(), id: 'local' }
    ]) {
      expect(() => registry.save(bad as never)).toThrow()
    }
    expect(registry.list()).toEqual([])
    expect(registry.save({ ...input(), url: '100.64.0.1:8123' }).url).toBe('http://100.64.0.1:8123')
  })
  it('does not overwrite malformed persisted data or load duplicate/local identities', () => {
    for (const content of [
      '{bad',
      '{"v":2,"connections":[]}',
      '{"v":1,"connections":[{"id":"local"}]}'
    ]) {
      ports.storage.write('server-connections.json', content)
      expect(() => new ServerConnectionRegistry(ports).list()).toThrow(/saved server/i)
      expect(ports.storage.read('server-connections.json')).toBe(content)
    }
  })
})
