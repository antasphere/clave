/**
 * The end-to-end suite's seam into the sessions, under `--test-no-activate`
 * only. The specs used to wrap an IPC handler (`ipcMain._invokeHandlers`) to
 * see what the composer wrote; the writes now cross the server, so the thing
 * to wrap is the session host, and this is where a spec finds it:
 * `globalThis.__claveE2E.sessionHost`. Nothing else of the sessions is
 * exposed, and outside test mode nothing is. The namespace is shared with the
 * other domains (lane B's terminal journal lives beside this): it is created
 * when absent and extended in place, never replaced, so whichever domain
 * installs first, the others' hooks stay.
 */
import type { SessionHostService } from '@clave/server'
import { TEST_NO_ACTIVATE } from '../test-mode'

export interface E2eHooks {
  /** Lane A: the sessions' host, wrapped by the chat and terminal-view specs. */
  sessionHost: SessionHostService
  // ── Lane B: terminalJournal · later lanes add theirs here ──
}

/** Install what a domain exposes; a domain passes its own fields and no other. */
export function installE2eHooks(hooks: Partial<E2eHooks>): void {
  if (!TEST_NO_ACTIVATE) return
  const g = globalThis as typeof globalThis & { __claveE2E?: Partial<E2eHooks> }
  g.__claveE2E ??= {}
  Object.assign(g.__claveE2E, hooks)
}
