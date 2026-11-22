/**
 * The person's Antigravity rung (Settings → Harnesses), read where it was
 * written. The launch settings are saved by the app, in the app's own
 * `preferences.json`; a packaged app spawns from a separate server on a
 * folder of its own, which holds no copy: measured on 22 November 2026, a
 * saved Plan never reached that server, which was harmless while "nothing
 * said" asked and is not now that it runs in Auto. The server the app starts
 * is told the app's folder (`--shell-data-dir`) and reads the setting there,
 * at each spawn, never writing it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeHarnessSettings } from '../shared/harness'
import { preferencesManager } from './preferences-manager'

let shellDir: string | undefined

export function readAntigravitySettingFrom(dir: string | undefined): void {
  shellDir = dir
}

const rungOf = (settings: unknown): string | undefined =>
  sanitizeHarnessSettings(settings).antigravity?.permissionDefault

export function personAntigravityRung(): string | undefined {
  if (shellDir) {
    try {
      const saved: unknown = JSON.parse(readFileSync(join(shellDir, 'preferences.json'), 'utf8'))
      return rungOf((saved as { harnessSettings?: unknown } | null)?.harnessSettings)
    } catch (error) {
      // A file that is there and does not read could have said Ask.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'default'
    }
  }
  return rungOf(preferencesManager.get('harnessSettings'))
}
