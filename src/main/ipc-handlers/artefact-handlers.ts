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
/** An optional argument: a string, or nothing (never an empty string). */
const optional = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

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
  // A target names one of the session's artefacts (PRDCT-5022); unnamed, nothing is passed.
  on('hold', (api, sessionId, holdId, target) => {
    const wanted = optional(target)
    return wanted === undefined
      ? api.artefacts.hold(text(sessionId), optional(holdId))
      : api.artefacts.hold(text(sessionId), optional(holdId), wanted)
  })
  on('release', (api, sessionId, holdId) => api.artefacts.release(text(sessionId), text(holdId)))
  on('saveVersion', (api, sessionId, target) => {
    const wanted = optional(target)
    return wanted === undefined
      ? api.artefacts.saveVersion(text(sessionId))
      : api.artefacts.saveVersion(text(sessionId), wanted)
  })
  on('versions', (api, sessionId, target) => {
    const wanted = optional(target)
    return wanted === undefined
      ? api.artefacts.versions(text(sessionId))
      : api.artefacts.versions(text(sessionId), wanted)
  })
  on('close', (api, sessionId, target) => {
    const wanted = optional(target)
    return wanted === undefined
      ? api.artefacts.close(text(sessionId))
      : api.artefacts.close(text(sessionId), wanted)
  })
  on('slidelessState', (api) => api.artefacts.slidelessState())
  on('installSlideless', (api) => api.artefacts.installSlideless())
}
