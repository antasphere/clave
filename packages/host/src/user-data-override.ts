import { app } from 'electron'

/** Honor `--user-data-dir=<path>` for REAL profile isolation.
 *
 *  Electron does NOT apply this Chromium switch to app.getPath('userData') by
 *  itself, so before this module existed the documented Playwright-Electron
 *  test setup silently shared the installed app's real data directory —
 *  preferences, pins, session records, localStorage — with whatever test
 *  instance was launched. This module must be imported FIRST in main/index.ts:
 *  several managers capture app.getPath('userData') at module-import time.
 */
const overrideDir = app.commandLine.getSwitchValue('user-data-dir')
if (overrideDir) {
  app.setPath('userData', overrideDir)
  // sessionData (Chromium storage: localStorage, IndexedDB, caches) follows
  // userData by default only when unset — set it explicitly so renderer
  // storage is isolated too, not just our JSON files.
  app.setPath('sessionData', overrideDir)
}
