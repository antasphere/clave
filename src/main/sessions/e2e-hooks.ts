/**
 * The end-to-end suite's seam into the sessions, under `--test-no-activate`
 * only. The specs used to wrap an IPC handler (`ipcMain._invokeHandlers`) to
 * see what the composer wrote; the writes now cross the server, so the thing
 * to wrap is the session host, and this is where a spec finds it:
 * `globalThis.__claveE2E.sessionHost`. Nothing else is exposed, and outside
 * test mode nothing is.
 */
import type { SessionHostService } from '@clave/server'
import { TEST_NO_ACTIVATE } from '../test-mode'

export interface E2eHooks {
  sessionHost: SessionHostService
}

export function installE2eHooks(hooks: E2eHooks): void {
  if (!TEST_NO_ACTIVATE) return
  const g = globalThis as typeof globalThis & { __claveE2E?: Partial<E2eHooks> }
  g.__claveE2E = { ...g.__claveE2E, ...hooks }
}
