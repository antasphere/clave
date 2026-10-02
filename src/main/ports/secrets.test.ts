import { describe, it, expect } from 'vitest'
import { keychainSecrets, KEYCHAIN_HANDLE_PREFIX, type SecretPort } from './secrets'
import { fakeSecurity } from './testing'

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789'

function port(security = fakeSecurity(), platform: NodeJS.Platform = 'darwin'): SecretPort {
  return keychainSecrets({
    service: 'Clave test',
    run: security.run,
    platform,
    exists: () => true
  })
}

/**
 * The Keychain adapter, over a `security` stand-in that parses the commands
 * the way the real one does. The adapter is the standalone server's only
 * place for a secret, and every rule here fails silently: a value on the
 * command line is readable in the process list, a handle that leaks the
 * value puts the token in a JSON file, and a foreign string opened as a
 * handle hands the wrong account's token to a spawn.
 */
describe('keychainSecrets', () => {
  it('seals a value into one item under a fresh handle, and the handle says nothing about it', () => {
    const security = fakeSecurity()
    const sealed = port(security).seal(TOKEN)
    expect(sealed.startsWith(KEYCHAIN_HANDLE_PREFIX)).toBe(true)
    expect(sealed).not.toContain(TOKEN)
    expect([...security.items.values()]).toEqual([TOKEN])
    expect([...security.items.keys()][0]).toBe(
      `Clave test\u0000${sealed.slice(KEYCHAIN_HANDLE_PREFIX.length)}`
    )
  })

  it('hands the value to security on its standard input, never as an argument', () => {
    const security = fakeSecurity()
    port(security).seal(TOKEN)
    const [add] = security.calls
    expect(add.args).toEqual(['-i'])
    expect(add.input).toContain(`-w "${TOKEN}"`)
    expect(add.input).toContain('add-generic-password -U -s "Clave test"')
  })

  it('quotes what the security line parser treats specially', () => {
    const security = fakeSecurity()
    const odd = 'pa"ss\\word'
    const sealed = port(security).seal(odd)
    expect(port(security).open(sealed)).toBe(odd)
  })

  it('opens what it sealed, through a read that prints the value and nothing else', () => {
    const security = fakeSecurity()
    const p = port(security)
    const sealed = p.seal(TOKEN)
    expect(p.open(sealed)).toBe(TOKEN)
    const read = security.calls[security.calls.length - 1]
    expect(read.args).toEqual([
      'find-generic-password',
      '-s',
      'Clave test',
      '-a',
      sealed.slice(KEYCHAIN_HANDLE_PREFIX.length),
      '-w'
    ])
    expect(read.input).toBeUndefined()
  })

  it('opens a string that is not its own to nothing, without asking the keychain', () => {
    const security = fakeSecurity()
    const p = port(security)
    expect(p.open(Buffer.from(`enc:${TOKEN}`).toString('base64'))).toBeUndefined()
    expect(p.open('')).toBeUndefined()
    expect(security.calls).toEqual([])
  })

  it('opens a handle whose item is gone to nothing', () => {
    const security = fakeSecurity()
    const p = port(security)
    const sealed = p.seal(TOKEN)
    security.items.clear()
    expect(p.open(sealed)).toBeUndefined()
  })

  it('discards the item, and discarding twice or discarding a foreign string is quiet', () => {
    const security = fakeSecurity()
    const p = port(security)
    const sealed = p.seal(TOKEN)
    p.discard(sealed)
    expect(security.items.size).toBe(0)
    p.discard(sealed)
    p.discard('not-ours')
    expect(security.calls.filter((c) => c.args[0] === 'delete-generic-password')).toHaveLength(2)
  })

  it('is unavailable off macOS, and sealing there throws rather than storing plaintext', () => {
    const security = fakeSecurity()
    const p = port(security, 'linux')
    expect(p.available()).toBe(false)
    expect(() => p.seal(TOKEN)).toThrow(/Keychain/)
    expect(security.items.size).toBe(0)
    expect(p.open(`${KEYCHAIN_HANDLE_PREFIX}x`)).toBeUndefined()
  })
})
