import { permissionRungFor, useLaunchSettingsStore } from '../store/launch-settings-store'

/** This app's Antigravity permission setting as every Antigravity spawn
 *  carries it, for a server that cannot read it (`main/antigravity-setting.ts`):
 *  a default below the profile, never the pick `permissionMode` is. */
export function antigravitySettingField(antigravity: boolean | undefined): {
  permissionDefault?: string
} {
  if (!antigravity) return {}
  const rung = permissionRungFor(useLaunchSettingsStore.getState().harnesses, 'antigravity')
  return rung ? { permissionDefault: rung } : {}
}
