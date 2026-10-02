import type { SettingsPorts } from './registry'
import { keychainSecrets } from './secrets'
import { fileStorage } from './storage'

/** The environment variable that names the standalone server's data directory. */
export const DATA_DIR_ENV = 'CLAVE_DATA_DIR'
/** The Keychain service the standalone server's secrets are filed under. */
export const KEYCHAIN_SERVICE = 'Clave server'

/** The data directory the environment names, or undefined: the server's
 *  configuration owns the default, this module never guesses one, because a
 *  guess that lands on the app's own folder would have two processes writing
 *  the same files. */
export function dataDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[DATA_DIR_ENV]?.trim()
  return value ? value : undefined
}

/** The standalone server's ports: JSON documents under a configured data
 *  directory, secrets in the macOS Keychain through the `security` CLI. */
export function standalonePorts(options: {
  dataDir: string
  keychainService?: string
}): SettingsPorts {
  return {
    storage: fileStorage(options.dataDir),
    secrets: keychainSecrets({ service: options.keychainService ?? KEYCHAIN_SERVICE })
  }
}
