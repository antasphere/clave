/**
 * The devices port of a Clave server (mobile wave, lane A, issue #281): the
 * device records in `devices.json` under the settings storage port (mode
 * 0600, like `server-connections.json`), the owner read off the Antasphere
 * login of the process that owns the server (the shell's manager in-process,
 * the standalone server's own when it runs alone), the issuer override of
 * the environment and the machine's hostname as the server's name. No relay
 * address: a phone reaches this server directly (over a private network,
 * by its own HTTPS address), so the relay routes answer unavailable. One
 * function for both entries; it imports no Electron and
 * loads nothing of the server package but its types, so the shell's server
 * file stays as light as it was.
 */
import * as os from 'os'
import { randomBytes } from 'node:crypto'
import type { DevicesPortService } from '@clave/server'
import type { AntasphereAccountStatus } from '../../shared/antasphere-account-types'
import { lazySettingsPorts } from '../ports/registry'

/** The document the records live in, under the storage port's directory. */
export const DEVICES_DOCUMENT = 'devices.json'
/** The document the phone road's machine id lives in, beside the records
 *  (PRDCT-4448): minted once, so a paired phone finds this server under the
 *  same id after every restart. */
export const PHONE_ROAD_DOCUMENT = 'phone-road.json'
const MACHINE_ID = /^m_[0-9a-f]{32}$/

/** This server's machine id on the phone's road: read from its document, or
 *  minted into it when there is none. A document that cannot be read, or
 *  holds anything else, throws: the road then answers nothing rather than
 *  under a second id. */
export function phoneRoadMachineId(): string {
  const storage = lazySettingsPorts.storage
  if (!storage.readChecked) throw new Error('Checked reads are required.')
  const text = storage.readChecked(PHONE_ROAD_DOCUMENT)
  if (text !== null) {
    const parsed = JSON.parse(text) as { v?: unknown; machineId?: unknown }
    if (parsed.v === 1 && typeof parsed.machineId === 'string' && MACHINE_ID.test(parsed.machineId))
      return parsed.machineId
    throw new Error('The phone road document holds no machine id.')
  }
  const machineId = `m_${randomBytes(16).toString('hex')}`
  storage.write(PHONE_ROAD_DOCUMENT, JSON.stringify({ v: 1, machineId }), { mode: 0o600 })
  return machineId
}
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
  /** The version this server reports to a phone on its road (PRDCT-4448);
   *  with it the road exists, without it there is none. */
  readonly version?: string
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
    ...(options.version !== undefined && {
      road: {
        // Read once and kept for the process: the id never changes under a phone.
        machineId: (() => {
          let known: string | null = null
          return () => (known ??= phoneRoadMachineId())
        })(),
        platform:
          process.platform === 'darwin'
            ? 'macos'
            : process.platform === 'linux'
              ? 'linux'
              : 'unknown',
        version: options.version
      }
    }),
    ...(options.onPairingRequested && { onPairingRequested: options.onPairingRequested })
  }
}
