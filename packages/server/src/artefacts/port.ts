/**
 * The artefacts port (PRDCT-4472): what the server needs from whoever shows
 * a session's HTML artefact. The app's implementation
 * (`src/main/artefacts/service.ts`) keeps the links in the server's data
 * folder, runs the Slideless preview beside the files and saves a version at
 * each finished turn; a server with nothing behind it runs on
 * `ArtefactsPort.none`, which refuses every call as unavailable.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type {
  Artefact,
  ArtefactDeck,
  ArtefactEvent,
  ArtefactPreview,
  ArtefactShareRequest,
  ArtefactShareResult,
  ArtefactVersion,
  ArtefactVersions,
  SlidelessAccounts,
  SlidelessSignIn,
  SlidelessState
} from '@clave/contract/artefacts'

export type { ArtefactEvent }

/** Who a sign-in is for: a hub login to pick, an account's address. */
export interface SlidelessSignInOptions {
  readonly email?: string
  readonly hub?: string
}

/**
 * The implementation's "no" with the sentence for the person: answered as
 * the declared `ArtefactRefused`. The handlers recognise it by its name as
 * well as by its class, since the implementation may define its own copy
 * rather than load this package (the routines' refusal does the same).
 */
export class ArtefactRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtefactRefusal'
  }
}

export interface ArtefactsService {
  /** Link a session to a folder holding an HTML page, or to one `.html` file;
   *  with `present`, tell the windows to present it in a window of its own (PRDCT-4980). */
  readonly open: (sessionId: string, path: string, present?: boolean) => Promise<Artefact>
  /** Drop one of the session's links (`target`), or all of them, with their holds;
   *  a session with none is not an error. */
  readonly close: (sessionId: string, target?: string) => Promise<void>
  /** Hold (or renew a hold of) the running preview of one of the session's
   *  artefacts (`target`), its front one when absent. */
  readonly hold: (sessionId: string, holdId?: string, target?: string) => Promise<ArtefactPreview>
  /** Let go of a hold; an unknown one is ignored. */
  readonly release: (sessionId: string, holdId: string) => Promise<void>
  /** Save a version of one of the session's artefacts now (`target`, else the front one). */
  readonly saveVersion: (sessionId: string, target?: string) => Promise<ArtefactVersion>
  /** The versions of one of the session's artefacts, from its running preview. */
  readonly versions: (sessionId: string, target?: string) => Promise<ArtefactVersions>
  readonly list: () => Promise<readonly Artefact[]>
  readonly slidelessState: () => Promise<SlidelessState>
  /** Install, or update to, the registry's latest release. */
  readonly installSlideless: () => Promise<SlidelessState>
  // ── PRDCT-4266: the Slideless accounts of the server's machine ──
  /** The accounts as the server's own copy lists them; `checked` tries each sign-in on its site. */
  readonly slidelessAccounts: () => Promise<SlidelessAccounts>
  readonly checkSlidelessAccounts: () => Promise<SlidelessAccounts>
  readonly addSlidelessSite: (url: string) => Promise<SlidelessAccounts>
  /** The machine's « New links go to »: one of its sites, or none (`null`). */
  readonly setNewLinksSite: (origin: string | null) => Promise<SlidelessAccounts>
  /** The fix a site's profile offers, when it runs with no question (a check, a removal). */
  readonly runSlidelessFix: (origin: string, kind: string) => Promise<SlidelessAccounts>
  /** Start a site's e-mail code sign-in: answered once the code is asked, or at its end. */
  readonly startSlidelessSignIn: (
    origin: string,
    options: SlidelessSignInOptions
  ) => Promise<SlidelessSignIn>
  /** Give a sign-in its code: answered at its end. */
  readonly answerSlidelessSignIn: (id: string, code: string) => Promise<SlidelessSignIn>
  /** Let go of a sign-in; an unknown one is ignored. */
  readonly cancelSlidelessSignIn: (id: string) => Promise<void>
  /** Sign a site in with a key, given to the command on its input. */
  readonly pasteSlidelessKey: (origin: string, key: string) => Promise<SlidelessAccounts>
  // ── PRDCT-4266: an artefact's deck and its links ──
  /** The deck and the links of one of the session's artefacts. */
  readonly artefactDeck: (sessionId: string, target: string) => Promise<ArtefactDeck>
  /** Push one of the session's artefacts to its deck and make a link. */
  readonly shareArtefact: (
    sessionId: string,
    target: string,
    request: ArtefactShareRequest
  ) => Promise<ArtefactShareResult>
  /** Revoke one of the links Clave made to the artefact's deck. */
  readonly revokeArtefactLink: (
    sessionId: string,
    target: string,
    tokenId: string
  ) => Promise<ArtefactDeck>
  readonly subscribe: (listener: (event: ArtefactEvent) => void) => () => void
}

const NO_ARTEFACTS = new CapabilityUnavailable({
  capability: 'artefacts',
  message: 'This server shows no artefacts.'
})
const refuse = (): Promise<never> => Promise.reject(NO_ARTEFACTS)

export class ArtefactsPort extends Context.Tag('@clave/server/Artefacts')<
  ArtefactsPort,
  ArtefactsService
>() {
  static layer(service: ArtefactsService): Layer.Layer<ArtefactsPort> {
    return Layer.succeed(ArtefactsPort, service)
  }
  /** A server with no artefacts behind it: every call says so, nothing is heard. */
  static readonly none: ArtefactsService = {
    open: refuse,
    close: refuse,
    hold: refuse,
    release: refuse,
    saveVersion: refuse,
    versions: refuse,
    list: refuse,
    slidelessState: refuse,
    installSlideless: refuse,
    slidelessAccounts: refuse,
    checkSlidelessAccounts: refuse,
    addSlidelessSite: refuse,
    setNewLinksSite: refuse,
    runSlidelessFix: refuse,
    startSlidelessSignIn: refuse,
    answerSlidelessSignIn: refuse,
    cancelSlidelessSignIn: refuse,
    pasteSlidelessKey: refuse,
    artefactDeck: refuse,
    shareArtefact: refuse,
    revokeArtefactLink: refuse,
    subscribe: () => () => {}
  }
}
