import type { SecretPort } from './secrets'
import type { SettingsPorts } from './registry'
import { fileStorage } from './storage'

/** What the adapter needs of Electron, as a shape rather than an import:
 *  this file carries no edge to the `electron` module, so the server build
 *  can hold it and a test can hand it a stand-in. The asynchronous half of
 *  `safeStorage`: the synchronous `isEncryptionAvailable`, `encryptString`
 *  and `decryptString` are deprecated in Electron 45 and gone in 46. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plain: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export interface ElectronLike {
  app: { getPath(name: 'userData'): string }
  safeStorage: SafeStorageLike
}

/**
 * Electron's `safeStorage`, the adapter the app has always used: the opaque
 * string is the OS-encrypted ciphertext in base64, which is exactly what
 * `claude-accounts-credentials.json` has held since the token accounts
 * exist, so nothing migrates — Electron reads what `encryptString` wrote
 * through `decryptStringAsync`. A value sealed on another machine, or by
 * the Keychain adapter, opens to undefined.
 */
export function safeStorageSecrets(safeStorage: SafeStorageLike): SecretPort {
  return {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    async seal(plain) {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error('OS encryption is unavailable, so the secret cannot be stored securely.')
      }
      return (await safeStorage.encryptStringAsync(plain)).toString('base64')
    },
    async open(sealed) {
      try {
        return (await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))).result
      } catch {
        return undefined
      }
    },
    async discard() {
      // The ciphertext lives in the domain's own document; dropping it there is the whole act.
    }
  }
}

/** The in-process server's ports: the app's own data folder and its OS
 *  encryption. The folder is read when this is called, never at import, so
 *  a `--user-data-dir` override is honoured wherever the first use happens. */
export function electronPorts(electron: ElectronLike): SettingsPorts {
  return {
    storage: fileStorage(electron.app.getPath('userData')),
    secrets: safeStorageSecrets(electron.safeStorage)
  }
}
