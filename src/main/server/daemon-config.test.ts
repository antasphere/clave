import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireDaemonLease, daemonConfig, daemonIdentity } from './daemon-config'
import { fileSecrets } from '../ports/secrets'
import { standalonePorts } from '../ports/standalone'

const dirs: string[] = []
const directory = (): string => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clave-vps-b-private-'))
  dirs.push(dir)
  return dir
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

describe('daemon configuration and credential persistence', () => {
  it('keeps loopback default, binds explicitly, and rejects parent-coupled daemon mode', () => {
    expect(daemonConfig([])).toEqual({ daemon: false, host: '127.0.0.1' })
    expect(daemonConfig(['--daemon', '--host=100.64.0.2']).host).toBe('100.64.0.2')
    expect(daemonConfig(['--daemon', '--host', 'fd7a:115c:a1e0::2']).host).toContain('fd7a:')
    for (const args of [
      ['--daemon', '--parent', '42'],
      ['--daemon', '--token', 'private'],
      ['--daemon', '--host'],
      ['--daemon', '--host', '::'],
      ['--daemon', '--host', '0.0.0.0'],
      ['--host', '100.64.0.2']
    ])
      expect(() => daemonConfig(args)).toThrow()
  })

  it('persists the same identity/token, with owner-only permissions', () => {
    const dir = directory()
    const first = daemonIdentity(dir)
    expect(daemonIdentity(dir)).toEqual(first)
    expect(first.token.length).toBe(64)
    expect(fs.statSync(join(dir, 'daemon')).mode & 0o777).toBe(0o700)
    expect(fs.statSync(join(dir, 'daemon/identity.json')).mode & 0o777).toBe(0o600)
  })

  it('fails closed on corrupt, insecure or symlinked credential state', () => {
    const dir = directory()
    daemonIdentity(dir)
    const file = join(dir, 'daemon/identity.json')
    fs.chmodSync(file, 0o644)
    expect(() => daemonIdentity(dir)).toThrow()
    fs.chmodSync(file, 0o600)
    fs.writeFileSync(file, '{broken')
    expect(() => daemonIdentity(dir)).toThrow()
    fs.unlinkSync(file)
    const target = join(dir, 'elsewhere')
    fs.writeFileSync(target, '{}', { mode: 0o600 })
    fs.symlinkSync(target, file)
    expect(() => daemonIdentity(dir)).toThrow()
  })

  it('imports a private token file once and refuses silent credential changes', () => {
    const dir = directory()
    const file = join(dir, 'token')
    fs.writeFileSync(file, 'a'.repeat(64), { mode: 0o600 })
    expect(daemonIdentity(dir, file).token).toBe('a'.repeat(64))
    fs.writeFileSync(file, 'b'.repeat(64))
    expect(() => daemonIdentity(dir, file)).toThrow('differs')
  })
})

describe('Linux file secret port', () => {
  it('encrypts Unicode secrets durably, keeps key/value files private, and discards one handle', () => {
    const dir = join(directory(), 'secrets')
    const port = fileSecrets({ directory: dir })
    expect(port.available()).toBe(true)
    const plain = 'private-token-é\nwith-newline'
    const handle = port.seal(plain)
    expect(handle).not.toContain(plain)
    expect(fileSecrets({ directory: dir }).open(handle)).toBe(plain)
    for (const name of fs.readdirSync(dir)) {
      const file = join(dir, name)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(file).includes(Buffer.from(plain))).toBe(false)
    }
    expect(port.open('keychain:foreign')).toBeUndefined()
    expect(port.open('file:v1:../../outside')).toBeUndefined()
    port.discard(handle)
    expect(port.open(handle)).toBeUndefined()
  })

  it('rejects ciphertext swapping/tampering, exposed keys, and missing-key regeneration', () => {
    const dir = join(directory(), 'secrets')
    const port = fileSecrets({ directory: dir })
    const first = port.seal('first-token')
    const second = port.seal('second-token')
    const file = (handle: string): string => join(dir, `${handle.slice('file:v1:'.length)}.secret`)
    fs.copyFileSync(file(first), file(second))
    expect(port.open(second)).toBeUndefined()
    fs.chmodSync(join(dir, 'master.key'), 0o644)
    expect(port.available()).toBe(false)
    expect(port.open(first)).toBeUndefined()
    expect(() => port.seal('secret')).toThrow()
    fs.unlinkSync(join(dir, 'master.key'))
    expect(port.available()).toBe(false)
    expect(() => port.seal('secret')).toThrow('missing')
  })

  it('selects encrypted file storage for Linux standalone settings', () => {
    const dir = directory()
    const port = standalonePorts({ dataDir: dir, platform: 'linux' }).secrets
    const handle = port.seal('linux-settings-token')
    expect(standalonePorts({ dataDir: dir, platform: 'linux' }).secrets.open(handle)).toBe(
      'linux-settings-token'
    )
  })
})

it('allows one daemon writer and releases its lease on normal shutdown', () => {
  const dir = directory()
  const release = acquireDaemonLease(dir)
  expect(() => acquireDaemonLease(dir)).toThrow('already owns')
  release()
  const again = acquireDaemonLease(dir)
  again()
})
