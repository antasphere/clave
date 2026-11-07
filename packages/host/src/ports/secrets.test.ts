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
  it('seals a value into one item under a fresh handle, and the handle says nothing about it', async () => {
    const security = fakeSecurity()
    const sealed = await port(security).seal(TOKEN)
    expect(sealed.startsWith(KEYCHAIN_HANDLE_PREFIX)).toBe(true)
    expect(sealed).not.toContain(TOKEN)
    expect([...security.items.values()]).toEqual([TOKEN])
    expect([...security.items.keys()][0]).toBe(
      `Clave test\u0000${sealed.slice(KEYCHAIN_HANDLE_PREFIX.length)}`
    )
  })

  it('hands the value to security on its standard input, never as an argument', async () => {
    const security = fakeSecurity()
    await port(security).seal(TOKEN)
    const [add] = security.calls
    expect(add.args).toEqual(['-i'])
    expect(add.input).toContain(`-w "${TOKEN}"`)
    expect(add.input).toContain('add-generic-password -U -s "Clave test"')
  })

  it('quotes what the security line parser treats specially', async () => {
    const security = fakeSecurity()
    const odd = 'pa"ss\\word'
    const sealed = await port(security).seal(odd)
    expect(await port(security).open(sealed)).toBe(odd)
  })

  it('opens what it sealed, through a read that prints the value and nothing else', async () => {
    const security = fakeSecurity()
    const p = port(security)
    const sealed = await p.seal(TOKEN)
    expect(await p.open(sealed)).toBe(TOKEN)
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

  it('opens a string that is not its own to nothing, without asking the keychain', async () => {
    const security = fakeSecurity()
    const p = port(security)
    expect(await p.open(Buffer.from(`enc:${TOKEN}`).toString('base64'))).toBeUndefined()
    expect(await p.open('')).toBeUndefined()
    expect(security.calls).toEqual([])
  })

  it('opens a handle whose item is gone to nothing', async () => {
    const security = fakeSecurity()
    const p = port(security)
    const sealed = await p.seal(TOKEN)
    security.items.clear()
    expect(await p.open(sealed)).toBeUndefined()
  })

  it('discards the item, and discarding twice or discarding a foreign string is quiet', async () => {
    const security = fakeSecurity()
    const p = port(security)
    const sealed = await p.seal(TOKEN)
    await p.discard(sealed)
    expect(security.items.size).toBe(0)
    await p.discard(sealed)
    await p.discard('not-ours')
    expect(security.calls.filter((c) => c.args[0] === 'delete-generic-password')).toHaveLength(2)
  })

  it('refuses a value outside printable ASCII, and stores nothing', async () => {
    const security = fakeSecurity()
    const p = port(security)
    // A line break would be read by `security -i` as a second command.
    await expect(p.seal('first\nadd-generic-password -s x -a y -w z')).rejects.toThrow(
      /printable ASCII/
    )
    await expect(p.seal('tab\there')).rejects.toThrow(/printable ASCII/)
    // An accent is filed, but read back as hex by `find-generic-password -w`.
    await expect(p.seal('p\u00e4ssword')).rejects.toThrow(/printable ASCII/)
    await expect(p.seal('line\u2028separator')).rejects.toThrow(/printable ASCII/)
    expect(security.calls).toEqual([])
    expect(security.items.size).toBe(0)
    expect(await p.open(await p.seal('sk-ant-oat01-abc_DEF-123 "quoted" \\slash'))).toBe(
      'sk-ant-oat01-abc_DEF-123 "quoted" \\slash'
    )
  })

  it('is unavailable off macOS, and sealing there throws rather than storing plaintext', async () => {
    const security = fakeSecurity()
    const p = port(security, 'linux')
    expect(await p.available()).toBe(false)
    await expect(p.seal(TOKEN)).rejects.toThrow(/Keychain/)
    expect(security.items.size).toBe(0)
    expect(await p.open(`${KEYCHAIN_HANDLE_PREFIX}x`)).toBeUndefined()
  })
})

describe('keychainSecrets on a keychain file of its own', () => {
  it('names the file last on every subcommand, and nothing else changes', async () => {
    const security = fakeSecurity()
    const port = keychainSecrets({
      service: 'Clave test',
      run: security.run,
      platform: 'darwin',
      exists: () => true,
      keychainFile: '/tmp/run 1/test.keychain-db'
    })
    const sealed = await port.seal('value-1')
    expect(await port.open(sealed)).toBe('value-1')
    await port.discard(sealed)
    expect(await port.open(sealed)).toBeUndefined()
    const [add, find, del] = security.calls
    expect(add.args).toEqual(['-i'])
    expect(add.input).toMatch(/ -w "value-1" "\/tmp\/run 1\/test\.keychain-db"\n$/)
    expect(find.args.at(-1)).toBe('/tmp/run 1/test.keychain-db')
    expect(find.args.slice(0, -1)).toEqual([
      'find-generic-password',
      '-s',
      'Clave test',
      '-a',
      sealed.slice(KEYCHAIN_HANDLE_PREFIX.length),
      '-w'
    ])
    expect(del.args.at(-1)).toBe('/tmp/run 1/test.keychain-db')
    expect(security.items.size).toBe(0)
  })

  it('without a file, no subcommand names one: the login keychain as before', async () => {
    const security = fakeSecurity()
    const port = keychainSecrets({
      service: 'Clave test',
      run: security.run,
      platform: 'darwin',
      exists: () => true
    })
    await port.open(await port.seal('v'))
    expect(security.calls[0].input).toMatch(/ -w "v"\n$/)
    expect(security.calls[1].args.at(-1)).toBe('-w')
  })
})
