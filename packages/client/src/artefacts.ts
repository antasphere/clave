/**
 * The artefacts domain of the client (PRDCT-4472): a session's HTML artefact
 * on the server the session runs on. A window lists the links, holds the
 * preview it shows (and renews the hold), releases it, and reads or installs
 * the server's Slideless; an agent tool opens one. A refusal is thrown as
 * the contract's `ArtefactRefused` with its sentence, a server that shows no
 * artefacts as `CapabilityUnavailable`, like every declared failure.
 *
 * A hold may start the preview (a child the server spawns and waits on), and
 * an install downloads a package: both run on the patient deadline, as the
 * long git calls do. So does every call of the Slideless accounts and the
 * links that waits on a site (PRDCT-4266): a check, an added site, a fix, a
 * sign-in and its code, a key, a push and its link, a revocation.
 */
import type {
  Artefact,
  ArtefactDeck,
  ArtefactPreview,
  ArtefactShareRequest,
  ArtefactShareResult,
  ArtefactVersion,
  ArtefactVersions,
  SlidelessAccounts,
  SlidelessSignIn,
  SlidelessState
} from '@clave/contract/artefacts'
import type { Call } from './call'

export interface ArtefactsClient {
  readonly open: (sessionId: string, path: string, present?: boolean) => Promise<Artefact>
  readonly close: (sessionId: string, target?: string) => Promise<void>
  readonly hold: (sessionId: string, holdId?: string, target?: string) => Promise<ArtefactPreview>
  readonly release: (sessionId: string, holdId: string) => Promise<void>
  readonly saveVersion: (sessionId: string, target?: string) => Promise<ArtefactVersion>
  readonly versions: (sessionId: string, target?: string) => Promise<ArtefactVersions>
  readonly list: () => Promise<readonly Artefact[]>
  readonly slidelessState: () => Promise<SlidelessState>
  readonly installSlideless: () => Promise<SlidelessState>
  // ── PRDCT-4266: the Slideless accounts of the server's machine ──
  readonly slidelessAccounts: () => Promise<SlidelessAccounts>
  readonly checkSlidelessAccounts: () => Promise<SlidelessAccounts>
  readonly addSlidelessSite: (url: string) => Promise<SlidelessAccounts>
  readonly setNewLinksSite: (origin: string | null) => Promise<SlidelessAccounts>
  readonly runSlidelessFix: (origin: string, kind: string) => Promise<SlidelessAccounts>
  readonly startSlidelessSignIn: (
    origin: string,
    options?: { readonly email?: string; readonly hub?: string }
  ) => Promise<SlidelessSignIn>
  readonly answerSlidelessSignIn: (id: string, code: string) => Promise<SlidelessSignIn>
  readonly cancelSlidelessSignIn: (id: string) => Promise<void>
  readonly pasteSlidelessKey: (origin: string, key: string) => Promise<SlidelessAccounts>
  // ── PRDCT-4266: an artefact's deck and its links ──
  readonly artefactDeck: (sessionId: string, target: string) => Promise<ArtefactDeck>
  readonly shareArtefact: (
    sessionId: string,
    target: string,
    request: ArtefactShareRequest
  ) => Promise<ArtefactShareResult>
  readonly revokeArtefactLink: (
    sessionId: string,
    target: string,
    tokenId: string
  ) => Promise<ArtefactDeck>
}

export const artefactsClient = (call: Call, patientCall: Call = call): ArtefactsClient => ({
  open: (sessionId, path, present) =>
    call((c) =>
      c.artefacts.open({ payload: { sessionId, path, ...(present === true && { present }) } })
    ),
  close: (sessionId, target) =>
    call((c) =>
      c.artefacts.close({ payload: { sessionId, ...(target !== undefined && { target }) } })
    ).then(() => undefined),
  hold: (sessionId, holdId, target) =>
    patientCall((c) =>
      c.artefacts.hold({
        payload: {
          sessionId,
          ...(holdId !== undefined && { holdId }),
          ...(target !== undefined && { target })
        }
      })
    ),
  release: (sessionId, holdId) =>
    call((c) => c.artefacts.release({ payload: { sessionId, holdId } })).then(() => undefined),
  saveVersion: (sessionId, target) =>
    call((c) =>
      c.artefacts.saveVersion({ payload: { sessionId, ...(target !== undefined && { target }) } })
    ),
  versions: (sessionId, target) =>
    call((c) =>
      c.artefacts.versions({ payload: { sessionId, ...(target !== undefined && { target }) } })
    ),
  list: () => call((c) => c.artefacts.list({ payload: {} })),
  slidelessState: () => call((c) => c.artefacts.slidelessState({ payload: {} })),
  installSlideless: () => patientCall((c) => c.artefacts.installSlideless({ payload: {} })),
  slidelessAccounts: () => call((c) => c.artefacts.slidelessAccounts({ payload: {} })),
  checkSlidelessAccounts: () =>
    patientCall((c) => c.artefacts.checkSlidelessAccounts({ payload: {} })),
  addSlidelessSite: (url) => patientCall((c) => c.artefacts.addSlidelessSite({ payload: { url } })),
  setNewLinksSite: (origin) => call((c) => c.artefacts.setNewLinksSite({ payload: { origin } })),
  runSlidelessFix: (origin, kind) =>
    patientCall((c) => c.artefacts.runSlidelessFix({ payload: { origin, kind } })),
  startSlidelessSignIn: (origin, options = {}) =>
    patientCall((c) =>
      c.artefacts.startSlidelessSignIn({
        payload: {
          origin,
          ...(options.email !== undefined && { email: options.email }),
          ...(options.hub !== undefined && { hub: options.hub })
        }
      })
    ),
  answerSlidelessSignIn: (id, code) =>
    patientCall((c) => c.artefacts.answerSlidelessSignIn({ payload: { id, code } })),
  cancelSlidelessSignIn: (id) =>
    call((c) => c.artefacts.cancelSlidelessSignIn({ payload: { id } })).then(() => undefined),
  pasteSlidelessKey: (origin, key) =>
    patientCall((c) => c.artefacts.pasteSlidelessKey({ payload: { origin, key } })),
  artefactDeck: (sessionId, target) =>
    call((c) => c.artefacts.artefactDeck({ payload: { sessionId, target } })),
  shareArtefact: (sessionId, target, request) =>
    patientCall((c) => c.artefacts.shareArtefact({ payload: { sessionId, target, ...request } })),
  revokeArtefactLink: (sessionId, target, tokenId) =>
    patientCall((c) => c.artefacts.revokeArtefactLink({ payload: { sessionId, target, tokenId } }))
})
