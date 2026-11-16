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
  ArtefactEvent,
  ArtefactPreview,
  ArtefactVersion,
  ArtefactVersions,
  SlidelessState
} from '@clave/contract/artefacts'

export type { ArtefactEvent }

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
  /** Link a session to a folder holding an HTML page, or to one `.html` file. */
  readonly open: (sessionId: string, path: string) => Promise<Artefact>
  /** Drop the session's link and its holds; a session with none is not an error. */
  readonly close: (sessionId: string) => Promise<void>
  /** Hold (or renew a hold of) the running preview of the session's artefact. */
  readonly hold: (sessionId: string, holdId?: string) => Promise<ArtefactPreview>
  /** Let go of a hold; an unknown one is ignored. */
  readonly release: (sessionId: string, holdId: string) => Promise<void>
  /** Save a version of the session's artefact now. */
  readonly saveVersion: (sessionId: string) => Promise<ArtefactVersion>
  /** The versions of the session's artefact, from its running preview. */
  readonly versions: (sessionId: string) => Promise<ArtefactVersions>
  readonly list: () => Promise<readonly Artefact[]>
  readonly slidelessState: () => Promise<SlidelessState>
  /** Install, or update to, the registry's latest release. */
  readonly installSlideless: () => Promise<SlidelessState>
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
    subscribe: () => () => {}
  }
}
