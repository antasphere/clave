import type { SecretPort } from './secrets'
import type { SettingsPorts } from './registry'
import { fileStorage } from './storage'

/** What the adapter needs of Electron, as a shape rather than an import:
 *  this file carries no edge to the `electron` module, so the server build
 *  can hold it and a test can hand it a stand-in. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface ElectronLike {
  app: { getPath(name: 'userData'): string }
  safeStorage: SafeStorageLike
}

/**
 * Electron's `safeStorage`, the adapter the app has always used: the opaque
 * string is the OS-encrypted ciphertext in base64, which is exactly what
 * `claude-accounts-credentials.json` has held since the token accounts
 * exist, so nothing migrates. A value sealed on another machine, or by the
 * Keychain adapter, opens to undefined.
 */
export function safeStorageSecrets(safeStorage: SafeStorageLike): SecretPort {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    seal(plain) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS encryption is unavailable, so the secret cannot be stored securely.')
      }
      return safeStorage.encryptString(plain).toString('base64')
    },
    open(sealed) {
      try {
        return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
      } catch {
        return undefined
      }
    },
    discard() {
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
