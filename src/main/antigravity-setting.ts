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
import { stricterMode } from '../shared/antigravity-mode'

let shellDir: string | undefined
/** This process is a server on preferences of its own (`server-entry.ts`). */
let served = false

export function readAntigravitySettingFrom(dir: string | undefined): void {
  shellDir = dir
  served = true
}

const rungOf = (settings: unknown): string | undefined =>
  sanitizeHarnessSettings(settings).antigravity?.permissionDefault

/** `sent`: the setting of the app that asked for the spawn. It counts where
 *  this process cannot read that app's file (an attached server, a daemon),
 *  the stricter of it and this server's own; read here, the file wins, so a
 *  setting changed since is the one that holds. */
export function personAntigravityRung(sent?: string): string | undefined {
  if (shellDir) {
    try {
      const saved: unknown = JSON.parse(readFileSync(join(shellDir, 'preferences.json'), 'utf8'))
      return rungOf((saved as { harnessSettings?: unknown } | null)?.harnessSettings)
    } catch (error) {
      // A file that is there and does not read could have said Ask.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'default'
    }
  }
  const own = rungOf(preferencesManager.get('harnessSettings'))
  return served && !shellDir && sent !== undefined ? stricterMode(own, sent) : own
}
