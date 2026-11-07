/**
 * The devices port of a Clave server (mobile wave, lane A, issue #281): the
 * device records in `devices.json` under the settings storage port (mode
 * 0600, like `server-connections.json`), the owner read off the Antasphere
 * login of the process that owns the server (the shell's manager in-process,
 * the standalone server's own when it runs alone), the issuer override of
 * the environment, the machine's hostname as the server's name, and the
 * relay address in the preferences (`mobileRelayUrl`, which the relay
 * client reads). One function for both entries; it imports no Electron and
 * loads nothing of the server package but its types, so the shell's server
 * file stays as light as it was.
 */
import * as os from 'os'
import type { DevicesPortService } from '@clave/server'
import type { AntasphereAccountStatus } from '../../shared/antasphere-account-types'
import { lazySettingsPorts } from '../ports/registry'
import { preferencesManager } from '../preferences-manager'

/** The document the records live in, under the storage port's directory. */
export const DEVICES_DOCUMENT = 'devices.json'
/** The same variable `antasphere-account.ts` and the server's identity
 *  token module read; a literal here so nothing of the server package is
 *  loaded before the server starts. */
const ISSUER_ENV = 'CLAVE_ANTASPHERE_ISSUER'

export interface DevicesPortOptions {
  /** The Antasphere login of the process that owns the server, read at
   *  every pairing request: signed in, its subject is the owner's; anything
   *  else (signed out, no manager, a read that throws) means no owner. */
  readonly status: () => AntasphereAccountStatus | Promise<AntasphereAccountStatus> | null
  readonly env?: NodeJS.ProcessEnv
  readonly onPairingRequested?: DevicesPortService['onPairingRequested']
}

export function devicesPortFor(options: DevicesPortOptions): DevicesPortService {
  const env = options.env ?? process.env
  return {
    storage: {
      read: () => {
        const storage = lazySettingsPorts.storage
        // A lossy read cannot tell an absent document from a failed one;
        // the store admits nobody on a read it cannot trust.
        if (!storage.readChecked) throw new Error('Checked reads are required.')
        return storage.readChecked(DEVICES_DOCUMENT)
      },
      write: (text) => lazySettingsPorts.storage.write(DEVICES_DOCUMENT, text, { mode: 0o600 })
    },
    owner: async () => {
      try {
        const status = await options.status()
        return status !== null && status.phase === 'signed-in' && status.account
          ? status.account.subject
          : null
      } catch {
        return null
      }
    },
    issuer: env[ISSUER_ENV],
    serverName: () => os.hostname(),
    relay: {
      get: () => preferencesManager.get('mobileRelayUrl'),
      set: (url) => preferencesManager.set('mobileRelayUrl', url)
    },
    ...(options.onPairingRequested && { onPairingRequested: options.onPairingRequested })
  }
}
