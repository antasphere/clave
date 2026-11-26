/**
 * A session's artefact over IPC (PRDCT-4474), for a window whose server is
 * not named yet: each `artefacts:<member>` channel asks the server the boot
 * named through main's own typed client, whichever server that is
 * (in-process or attached). Main serves and versions nothing itself: the
 * artefact belongs to the server the session runs on. Before any server is
 * named, every channel refuses with one sentence, rather than waiting on a
 * boot the window cannot see.
 *
 * The Slideless accounts of the machine and an artefact's links (PRDCT-4266)
 * take the same road. A sign-in code, a key and a password pass through as
 * arguments only: nothing here keeps or logs them.
 *
 * The events have no IPC arm: they reach a window on the push channel only,
 * and the window lists again each time its server connects.
 */
import { ipcMain } from 'electron'
import type { ClaveApiClient } from '@clave/client'
import type { ArtefactShareRequest } from '@clave/contract/artefacts/model'
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
/** An object argument as the window gave it; the client's schema refuses a wrong shape. */
const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

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
  // ── PRDCT-4266: the Slideless accounts of the machine ──
  on('slidelessAccounts', (api) => api.artefacts.slidelessAccounts())
  on('checkSlidelessAccounts', (api) => api.artefacts.checkSlidelessAccounts())
  on('addSlidelessSite', (api, url) => api.artefacts.addSlidelessSite(text(url)))
  // No site named (null, or an empty one): « New links go to » is cleared.
  on('setNewLinksSite', (api, origin) => api.artefacts.setNewLinksSite(optional(origin) ?? null))
  on('runSlidelessFix', (api, origin, kind) =>
    api.artefacts.runSlidelessFix(text(origin), text(kind))
  )
  on('startSlidelessSignIn', (api, origin, options) => {
    const email = optional(fields(options).email)
    const hub = optional(fields(options).hub)
    return api.artefacts.startSlidelessSignIn(text(origin), {
      ...(email !== undefined && { email }),
      ...(hub !== undefined && { hub })
    })
  })
  on('answerSlidelessSignIn', (api, id, code) =>
    api.artefacts.answerSlidelessSignIn(text(id), text(code))
  )
  on('cancelSlidelessSignIn', (api, id) => api.artefacts.cancelSlidelessSignIn(text(id)))
  on('pasteSlidelessKey', (api, origin, key) =>
    api.artefacts.pasteSlidelessKey(text(origin), text(key))
  )
  // ── PRDCT-4266: an artefact's deck and its links ──
  on('artefactDeck', (api, sessionId, target) =>
    api.artefacts.artefactDeck(text(sessionId), text(target))
  )
  on('shareArtefact', (api, sessionId, target, request) =>
    api.artefacts.shareArtefact(
      text(sessionId),
      text(target),
      fields(request) as unknown as ArtefactShareRequest
    )
  )
  on('revokeArtefactLink', (api, sessionId, target, tokenId) =>
    api.artefacts.revokeArtefactLink(text(sessionId), text(target), text(tokenId))
  )
}
