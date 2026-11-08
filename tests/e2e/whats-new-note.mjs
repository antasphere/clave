// The release note the what's-new card shows is bundled: `help/whats-new.json`
// is read at build time, and the card appears only for the version the app
// runs (`WhatsNewBanner.tsx`: no entry for the running version, no card). Two
// specs drive that card (`announcement-disclosure`, `sidebar-whats-new`) and
// can only do so when the checkout carries a note for the version it builds.
// This reads the same file the bundle was built from, so a spec can say
// "no note for this version" as one red check instead of a crash on a card
// that is not there (PRDCT-4172, 8 November 2026: dev at 2.4.0 has notes up
// to 2.0.0 only).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO } from './harness.mjs'

export const WHATS_NEW_FILE = 'src/renderer/src/help/whats-new.json'

/** Every entry of the checkout's what's-new file, newest first as authored. */
export function whatsNewEntries() {
  return JSON.parse(readFileSync(path.join(REPO, WHATS_NEW_FILE), 'utf8'))
}

/** The entry the running app would show for `version`, or null. */
export function whatsNewNoteFor(version) {
  return whatsNewEntries().find((e) => e.version === version) ?? null
}

/** The stable check name both specs use, so known-failures.json can name it. */
export const NOTE_CHECK = 'help/whats-new.json carries a note for the version the app runs'

/** What the failed check prints: the version run and the newest note there is. */
export function noteDetail(version) {
  const entries = whatsNewEntries()
  return { version, newestNote: entries[0]?.version ?? null, notes: entries.length }
}
