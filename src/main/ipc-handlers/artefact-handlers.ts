/**
 * A session's artefact over IPC (PRDCT-4474), for a window whose server is
 * not named yet: each `artefacts:<member>` channel asks the server the boot
 * named through main's own typed client, whichever server that is
 * (in-process or attached). Main serves and versions nothing itself: the
 * artefact belongs to the server the session runs on. Before any server is
 * named, every channel refuses with one sentence, rather than waiting on a
 * boot the window cannot see.
 *
 * The events have no IPC arm: they reach a window on the push channel only,
 * and the window lists again each time its server connects.
 */
import { ipcMain } from 'electron'
import type { ClaveApiClient } from '@clave/client'
import { getClaveServerEndpoint } from '../server/endpoint'
import { serverClient } from '../mcp/server-client'

export const SERVER_NOT_READY = "Clave's server is not ready yet."

export interface ArtefactHandlerDeps {
  /** Whether the boot has named a server; none, and a call is refused. */
  readonly named: () => boolean
  readonly api: () => Promise<ClaveApiClient>
}

const defaults: ArtefactHandlerDeps = {
  named: () => getClaveServerEndpoint() !== null,
  api: () => serverClient.api()
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function registerArtefactHandlers(deps: ArtefactHandlerDeps = defaults): void {
  const on = <R>(
    member: string,
    call: (api: ClaveApiClient, ...args: unknown[]) => Promise<R>
  ): void => {
    ipcMain.handle(`artefacts:${member}`, async (_event, ...args: unknown[]) => {
      if (!deps.named()) throw new Error(SERVER_NOT_READY)
      return call(await deps.api(), ...args)
    })
  }
  on('list', (api) => api.artefacts.list())
  on('hold', (api, sessionId, holdId) =>
    api.artefacts.hold(text(sessionId), typeof holdId === 'string' ? holdId : undefined)
  )
  on('release', (api, sessionId, holdId) => api.artefacts.release(text(sessionId), text(holdId)))
  on('saveVersion', (api, sessionId) => api.artefacts.saveVersion(text(sessionId)))
  on('close', (api, sessionId) => api.artefacts.close(text(sessionId)))
  on('slidelessState', (api) => api.artefacts.slidelessState())
  on('installSlideless', (api) => api.artefacts.installSlideless())
}
