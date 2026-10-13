import type { SecretPort } from './secrets'
import type { StoragePort } from './storage'
import { electronPorts } from './electron'

/** The two ports every settings domain takes. */
export interface SettingsPorts {
  storage: StoragePort
  secrets: SecretPort
}

let installed: SettingsPorts | null = null

/** Name the ports the settings domains run on. The standalone server calls
 *  this once at boot; a test calls it with a temp directory. Inside Electron
 *  nobody has to: an unnamed registry resolves the app's own adapters. */
export function installSettingsPorts(ports: SettingsPorts): void {
  installed = ports
}

/** Forget the installed ports (tests). */
export function resetSettingsPorts(): void {
  installed = null
}

/** The ports in force. Throws, with the fix named, when the process is not
 *  Electron and nothing was installed: a server that silently read an empty
 *  folder would show no accounts and look fine. */
export function settingsPorts(): SettingsPorts {
  if (installed) return installed
  if (process.versions.electron) {
    // A `require`, not an import: this module and every manager behind it
    // carry no edge to Electron, so the same files build for the server.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    installed = electronPorts(require('electron') as typeof import('electron'))
    return installed
  }
  throw new Error(
    'No settings ports installed: call installSettingsPorts() before the settings domains are used.'
  )
}

/** The ports as the managers hold them: looked up at every use, so a manager
 *  built at import time still runs on whatever is installed by the time it is
 *  first used, and a test can swap the ports between cases. */
export const lazySettingsPorts: SettingsPorts = {
  get storage() {
    return settingsPorts().storage
  },
  get secrets() {
    return settingsPorts().secrets
  }
}
