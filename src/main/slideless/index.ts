/**
 * The Slideless command line as the app runs it (PRDCT-4262): Clave's own
 * copy under user data, installed silently at the first launch that finds
 * none (Romain's call, 9 November 2026), the artefact servers it runs, and the
 * IPC the renderer uses. `cli.ts` and `servers.ts` hold the behaviour and are
 * tested without Electron.
 */
import { app, ipcMain } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { broadcastToAllWindows } from '../window-routing'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { describeState, installSlideless, resolveCli, DEFAULT_REGISTRY } from './cli'
import { ArtefactServers } from './servers'
import type { SlidelessState } from '../../shared/slideless'

/** A registry to install from instead of npm's (the end-to-end specs' fixture). */
export const REGISTRY_ENV = 'CLAVE_TEST_SLIDELESS_REGISTRY'

const cliDir = (): string => join(app.getPath('userData'), 'slideless', 'cli')
const storeDir = (): string => join(app.getPath('userData'), 'slideless', 'versions')

let installing: Promise<SlidelessState> | null = null
let lastError: string | null = null

function state(): SlidelessState {
  return describeState(resolveCli(cliDir(), process.env), installing !== null, lastError)
}

function broadcast(): void {
  broadcastToAllWindows('slideless:state', state())
}

/** Install (or update to) the registry's latest; one run at a time, every caller awaits it. */
export function installManagedSlideless(): Promise<SlidelessState> {
  if (installing) return installing
  lastError = null
  installing = installSlideless(cliDir(), {
    fetch: globalThis.fetch,
    registry: process.env[REGISTRY_ENV]?.trim() || DEFAULT_REGISTRY
  })
    .then(() => {
      lastError = null
    })
    .catch((err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err)
    })
    .then(() => {
      installing = null
      const next = state()
      broadcastToAllWindows('slideless:state', next)
      return next
    })
  broadcast()
  return installing
}

export const artefactServers = new ArtefactServers({
  spawn,
  fetch: globalThis.fetch,
  execPath: process.execPath,
  store: storeDir(),
  resolveCli: () => resolveCli(cliDir(), process.env),
  // A child that died under its holders: the views serve again.
  onExit: (target) => broadcastToAllWindows('slideless:server-exited', target)
})

/**
 * At start: install in the background when no usable copy is there. A test
 * instance never reaches npm: it installs only from the fixture registry it
 * was given.
 */
export function startSlideless(): void {
  if (resolveCli(cliDir(), process.env).cli) return
  if (TEST_NO_ACTIVATE && !process.env[REGISTRY_ENV]) return
  void installManagedSlideless()
}

export function registerSlidelessHandlers(): void {
  ipcMain.handle('slideless:get-state', () => state())
  ipcMain.handle('slideless:install', () => installManagedSlideless())
  ipcMain.handle('slideless:serve', async (_event, target: unknown) => ({
    url: await artefactServers.serve(String(target))
  }))
  ipcMain.handle('slideless:release', (_event, target: unknown) => {
    artefactServers.release(String(target))
  })
  ipcMain.handle('slideless:snapshot', (_event, target: unknown) =>
    artefactServers.snapshot(String(target))
  )
  app.on('will-quit', () => artefactServers.stopAll())
}
