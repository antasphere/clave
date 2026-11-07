/**
 * The devices port as the shell gives it to its in-process server (mobile
 * wave, lane A): the shell's own Antasphere login as the owner. Loaded by
 * `clave-server.ts` with a dynamic import beside the server package, never
 * at main's boot, and under Electron alone; the standalone entry builds the
 * same port from its own login (`server-entry.ts`). The notice a pairing
 * request raises is not this port's: it travels as a server event and the
 * windows relay it to main (`devices-notify.ts`), the same road whether the
 * server runs in this process or apart.
 */
import type { DevicesPortService } from '@clave/server'
import { shellAntasphereAccount } from '../settings/shell-source'
import { devicesPortFor } from './devices-port'

export function shellDevicesPort(): DevicesPortService {
  return devicesPortFor({ status: () => shellAntasphereAccount?.status() ?? null })
}
