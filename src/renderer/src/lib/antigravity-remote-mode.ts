import { permissionRungFor, useLaunchSettingsStore } from '../store/launch-settings-store'
import type { SpawnPermissionMode } from '../../../shared/runtime-choices'

/** The mode an Antigravity open sends a server: the one named, else this
 *  Mac's setting, which that server cannot read (`main/antigravity-setting.ts`). */
export function antigravityRemoteMode(named?: string): { permissionMode?: SpawnPermissionMode } {
  const mode =
    named ?? permissionRungFor(useLaunchSettingsStore.getState().harnesses, 'antigravity')
  return mode ? { permissionMode: mode as SpawnPermissionMode } : {}
}
