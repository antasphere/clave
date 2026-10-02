import { describe, it, expect } from 'vitest'
import { electronPorts, safeStorageSecrets } from './electron'
import { fakeSafeStorage, tempDataDir } from './testing'

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Electron's `safeStorage` as a secret port. The on-disk shape is the one
 * the app has always written (base64 of the ciphertext), which is what
 * makes this change a refactor and not a migration: a credentials file from
 * before it opens exactly as before.
 */
describe('safeStorageSecrets', () => {
  it('seals to the base64 ciphertext, which is not the value, and opens it back', () => {
    const port = safeStorageSecrets(fakeSafeStorage())
    const sealed = port.seal(TOKEN)
    expect(sealed).toBe(Buffer.from(`enc:${TOKEN}`).toString('base64'))
    expect(sealed).not.toContain(TOKEN)
    expect(port.open(sealed)).toBe(TOKEN)
  })

  it('refuses to seal when the OS cannot encrypt, and never hands back plaintext', () => {
    const state = { available: true }
    const port = safeStorageSecrets(fakeSafeStorage(state))
    state.available = false
    expect(port.available()).toBe(false)
    expect(() => port.seal(TOKEN)).toThrow(/encryption/)
  })

  it('opens a string another machine or the Keychain adapter wrote to nothing', () => {
    const port = safeStorageSecrets(fakeSafeStorage())
    expect(port.open('keychain:abc')).toBeUndefined()
    expect(port.open(Buffer.from('not:ours').toString('base64'))).toBeUndefined()
  })

  it('has nothing of its own to discard', () => {
    const port = safeStorageSecrets(fakeSafeStorage())
    expect(() => port.discard(port.seal(TOKEN))).not.toThrow()
  })
})

describe('electronPorts', () => {
  it("files documents under the app's data folder as read when composed, not at import", () => {
    const first = tempDataDir()
    const second = tempDataDir()
    let userData = first
    const electron = {
      app: { getPath: () => userData },
      safeStorage: fakeSafeStorage()
    }
    userData = second
    const ports = electronPorts(electron)
    ports.storage.write('x.json', '1')
    expect(ports.storage.pathOf('x.json').startsWith(second)).toBe(true)
    expect(ports.secrets.open(ports.secrets.seal('v'))).toBe('v')
  })
})
