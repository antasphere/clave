import { describe, it, expect } from 'vitest'
import { electronPorts, safeStorageSecrets } from './electron'
import { fakeSafeStorage, tempDataDir } from './testing'

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Electron's `safeStorage` as a secret port. The on-disk shape is the one
 * the app has always written (base64 of the ciphertext), which is what
 * makes this change a refactor and not a migration: a credentials file from
 * before it opens exactly as before — through the asynchronous half of the
 * API, the only half left in Electron 46.
 */
describe('safeStorageSecrets', () => {
  it('seals to the base64 ciphertext, which is not the value, and opens it back', async () => {
    const port = safeStorageSecrets(fakeSafeStorage())
    const sealed = await port.seal(TOKEN)
    expect(sealed).toBe(Buffer.from(`enc:${TOKEN}`).toString('base64'))
    expect(sealed).not.toContain(TOKEN)
    expect(await port.open(sealed)).toBe(TOKEN)
  })

  it('refuses to seal when the OS cannot encrypt, and never hands back plaintext', async () => {
    const state = { available: true }
    const port = safeStorageSecrets(fakeSafeStorage(state))
    state.available = false
    expect(await port.available()).toBe(false)
    await expect(port.seal(TOKEN)).rejects.toThrow(/encryption/)
  })

  it('opens a string another machine or the Keychain adapter wrote to nothing', async () => {
    const port = safeStorageSecrets(fakeSafeStorage())
    expect(await port.open('keychain:abc')).toBeUndefined()
    expect(await port.open(Buffer.from('not:ours').toString('base64'))).toBeUndefined()
  })

  it('has nothing of its own to discard', async () => {
    const port = safeStorageSecrets(fakeSafeStorage())
    await expect(port.discard(await port.seal(TOKEN))).resolves.toBeUndefined()
  })
})

describe('electronPorts', () => {
  it("files documents under the app's data folder as read when composed, not at import", async () => {
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
    expect(await ports.secrets.open(await ports.secrets.seal('v'))).toBe('v')
  })
})
