import { app, shell, systemPreferences } from 'electron'
import type { MicAccessState, MicAccessStatus } from '../shared/mic'

/**
 * The OS side of the Audio settings page: report the real permission status,
 * run the native prompt (macOS), open the privacy pane. All platform
 * branching lives here — the renderer only consumes `MicAccessState`.
 *
 * Ported from Réplique (`app/src/main/mic-access.ts`).
 */

/** Per-platform deep link into the OS microphone privacy pane; null = none (Linux). */
const SETTINGS_URL: string | null =
  process.platform === 'darwin'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    : process.platform === 'win32'
      ? 'ms-settings:privacy-microphone'
      : null

function readStatus(): MicAccessStatus {
  // getMediaAccessStatus exists on macOS and Windows only; elsewhere the OS
  // has no app-level microphone permission to query.
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unknown'
  return systemPreferences.getMediaAccessStatus('microphone')
}

export function getMicAccessState(): MicAccessState {
  const status = readStatus()
  return {
    status,
    // Unpackaged on macOS, the permission belongs to the app that launched the
    // dev server (terminal, editor…), not to Clave — when it is missing, the
    // page must say so. Never true when packaged.
    devPermissionCaveat: !app.isPackaged && process.platform === 'darwin' && status !== 'granted',
    canOpenSettings: SETTINGS_URL !== null
  }
}

/**
 * macOS `not-determined`: shows the native permission prompt and resolves when
 * the user answers. Everywhere else — and for every other status — a no-op:
 * `askForMediaAccess` silently resolves false once the permission is denied,
 * which would leave the button doing nothing at all. Callers get the fresh
 * state back either way, and a denied permission is fixed in the privacy pane.
 */
export async function requestMicAccess(): Promise<MicAccessState> {
  if (process.platform === 'darwin' && readStatus() === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone').catch(() => false)
  }
  return getMicAccessState()
}

export async function openMicPrivacySettings(): Promise<void> {
  if (SETTINGS_URL) await shell.openExternal(SETTINGS_URL)
}
