import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it.each(['::0', '0:0:0:0:0:0:0:0', '0', '0.0', '0x0', '0000', '0.0.0.0.', '::ffff:0.0.0.0'])(
    'rejects the wildcard alias %s before daemon startup',
    (host) => {
      expect(() => daemonConfig(['--daemon', '--host', host])).toThrow('never a wildcard')
    }
  )

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

it('serializes stale reclamation before checking a dead owner', () => {
  const dir = directory()
  const daemon = join(dir, 'daemon')
  fs.mkdirSync(daemon, { mode: 0o700 })
  const stale = 2147483647
  fs.writeFileSync(join(daemon, 'process.json'), JSON.stringify({ pid: stale }), { mode: 0o600 })
  let nested = false
  const contenders: Array<() => void> = []
  let rejected: unknown
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid !== stale) return true
    if (!nested) {
      nested = true
      try {
        contenders.push(acquireDaemonLease(dir))
      } catch (error) {
        rejected = error
      }
    }
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
  })
  let release: (() => void) | undefined
  try {
    release = acquireDaemonLease(dir)
    expect(contenders).toHaveLength(0)
    expect(rejected).toBeInstanceOf(Error)
    expect(JSON.parse(fs.readFileSync(join(daemon, 'process.json'), 'utf8')).pid).toBe(process.pid)
  } finally {
    release?.()
    contenders.forEach((release) => release())
    kill.mockRestore()
  }
})

it('does not let a previous release delete a newer claim from the same PID', () => {
  const dir = directory()
  const oldRelease = acquireDaemonLease(dir)
  oldRelease()
  const currentRelease = acquireDaemonLease(dir)
  try {
    oldRelease()
    expect(() => acquireDaemonLease(dir)).toThrow('already owns')
  } finally {
    currentRelease()
  }
})

it('recovers a dead acquisition claim without requiring shared guard removal', () => {
  const dir = directory()
  const release = acquireDaemonLease(dir)
  const lease = JSON.parse(fs.readFileSync(join(dir, 'daemon/process.json'), 'utf8'))
  release()
  const stale = join(
    dir,
    'daemon/process-claims',
    `${lease.bootId}_2147483647_11111111-1111-4111-8111-111111111111.claim`
  )
  fs.writeFileSync(stale, '', { mode: 0o600 })
  const guard = join(dir, 'daemon/process.guard')
  fs.writeFileSync(guard, JSON.stringify({ pid: 2147483647 }), { mode: 0o600 })
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  try {
    const recovered = acquireDaemonLease(dir)
    expect(fs.existsSync(stale)).toBe(false)
    recovered()
  } finally {
    kill.mockRestore()
  }
})

it('rejects an active claim before a shared process lease has been published', () => {
  const dir = directory()
  const release = acquireDaemonLease(dir)
  fs.unlinkSync(join(dir, 'daemon/process.json'))
  try {
    expect(() => acquireDaemonLease(dir)).toThrow('already owns')
  } finally {
    release()
  }
})

it('does not confuse a claim from a previous boot with a reused live PID', () => {
  const dir = directory()
  const release = acquireDaemonLease(dir)
  release()
  const oldBoot = '00000000-0000-0000-0000-000000000000'
  const stale = join(
    dir,
    'daemon/process-claims',
    `${oldBoot}_${process.pid}_11111111-1111-4111-8111-111111111111.claim`
  )
  fs.writeFileSync(stale, '', { mode: 0o600 })
  fs.writeFileSync(
    join(dir, 'daemon/process.json'),
    JSON.stringify({ pid: process.pid, bootId: oldBoot }),
    { mode: 0o600 }
  )
  const recovered = acquireDaemonLease(dir)
  expect(fs.existsSync(stale)).toBe(false)
  recovered()
})

it('keeps live same-boot PID reuse conservative, regardless of claim UUID', () => {
  const dir = directory()
  const release = acquireDaemonLease(dir)
  const lease = JSON.parse(fs.readFileSync(join(dir, 'daemon/process.json'), 'utf8'))
  release()
  const stale = join(
    dir,
    'daemon/process-claims',
    `${lease.bootId}_${process.pid}_11111111-1111-4111-8111-111111111111.claim`
  )
  fs.writeFileSync(stale, '', { mode: 0o600 })
  expect(() => acquireDaemonLease(dir)).toThrow('already owns')
  expect(fs.existsSync(stale)).toBe(true)
})

it.each(['null', 'false', '{"pid":0}', '{"pid":1,"bootId":"invalid"}'])(
  'refuses corrupt process metadata %s without publishing a claim',
  (metadata) => {
    const dir = directory()
    const release = acquireDaemonLease(dir)
    release()
    fs.writeFileSync(join(dir, 'daemon/process.json'), metadata, { mode: 0o600 })
    expect(() => acquireDaemonLease(dir)).toThrow()
    expect(fs.readFileSync(join(dir, 'daemon/process.json'), 'utf8')).toBe(metadata)
    expect(fs.readdirSync(join(dir, 'daemon/process-claims'))).toHaveLength(0)
  }
)

it('refuses an uncertain live owner rather than treating EPERM as a dead process', () => {
  const dir = directory()
  const release = acquireDaemonLease(dir)
  const lease = JSON.parse(fs.readFileSync(join(dir, 'daemon/process.json'), 'utf8'))
  release()
  const claimed = join(
    dir,
    'daemon/process-claims',
    `${lease.bootId}_2147483647_11111111-1111-4111-8111-111111111111.claim`
  )
  fs.writeFileSync(claimed, '', { mode: 0o600 })
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
  })
  try {
    expect(() => acquireDaemonLease(dir)).toThrow('not permitted')
    expect(fs.existsSync(claimed)).toBe(true)
  } finally {
    kill.mockRestore()
  }
})
