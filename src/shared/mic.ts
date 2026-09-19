/**
 * The microphone's OS-permission state, shared between main and the Audio
 * settings page.
 *
 * Only main can ask macOS about the microphone (`systemPreferences`), show the
 * native prompt, or open the privacy pane (`shell.openExternal`). The renderer
 * only ever sees this snapshot and asks main to act.
 *
 * Ported from Réplique (`app/src/shared/mic.ts`), the Electron app this
 * surface was first built in.
 */

/**
 * Mirrors `systemPreferences.getMediaAccessStatus('microphone')`.
 * `unknown` = this OS exposes no queryable status (Linux), where the stream's
 * own evidence is all there is.
 */
export type MicAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface MicAccessState {
  status: MicAccessStatus
  /**
   * True only when the app runs unpackaged on macOS AND the permission is not
   * granted: there the system permission belongs to whatever launched the dev
   * server (the terminal, the editor), not to Clave, so the page says so
   * instead of blaming Clave. Always false in a packaged app.
   */
  devPermissionCaveat: boolean
  /** Whether this OS has a privacy-settings deep link main can open. */
  canOpenSettings: boolean
}

export const MIC_GET_ACCESS_CHANNEL = 'mic:get-access'
export const MIC_REQUEST_ACCESS_CHANNEL = 'mic:request-access'
export const MIC_OPEN_SETTINGS_CHANNEL = 'mic:open-settings'
