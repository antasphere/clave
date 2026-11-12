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
 * long git calls do.
 */
import type {
  Artefact,
  ArtefactPreview,
  ArtefactVersion,
  SlidelessState
} from '@clave/contract/artefacts'
import type { Call } from './call'

export interface ArtefactsClient {
  readonly open: (sessionId: string, path: string) => Promise<Artefact>
  readonly close: (sessionId: string) => Promise<void>
  readonly hold: (sessionId: string, holdId?: string) => Promise<ArtefactPreview>
  readonly release: (sessionId: string, holdId: string) => Promise<void>
  readonly saveVersion: (sessionId: string) => Promise<ArtefactVersion>
  readonly list: () => Promise<readonly Artefact[]>
  readonly slidelessState: () => Promise<SlidelessState>
  readonly installSlideless: () => Promise<SlidelessState>
}

export const artefactsClient = (call: Call, patientCall: Call = call): ArtefactsClient => ({
  open: (sessionId, path) => call((c) => c.artefacts.open({ payload: { sessionId, path } })),
  close: (sessionId) =>
    call((c) => c.artefacts.close({ payload: { sessionId } })).then(() => undefined),
  hold: (sessionId, holdId) =>
    patientCall((c) =>
      c.artefacts.hold({ payload: { sessionId, ...(holdId !== undefined && { holdId }) } })
    ),
  release: (sessionId, holdId) =>
    call((c) => c.artefacts.release({ payload: { sessionId, holdId } })).then(() => undefined),
  saveVersion: (sessionId) => call((c) => c.artefacts.saveVersion({ payload: { sessionId } })),
  list: () => call((c) => c.artefacts.list({ payload: {} })),
  slidelessState: () => call((c) => c.artefacts.slidelessState({ payload: {} })),
  installSlideless: () => patientCall((c) => c.artefacts.installSlideless({ payload: {} }))
})
