/**
 * The artefacts domain on the buses (PRDCT-4472): each command and query one
 * call on the port. A thrown `ArtefactRefusal` (the implementation's "no",
 * recognised by its name) is the declared `ArtefactRefused` with its
 * sentence; anything else is `CapabilityUnavailable`, as the speech maps
 * what its port throws.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  ArtefactRefused,
  CloseArtefact,
  GetSlidelessState,
  HoldArtefactPreview,
  InstallSlideless,
  ListArtefacts,
  ListArtefactVersions,
  OpenArtefact,
  ReleaseArtefactPreview,
  SaveArtefactVersion
} from '@clave/contract/artefacts'
import { ArtefactsPort, ArtefactRefusal, type ArtefactsService } from './port'

const isRefusal = (error: unknown): error is Error =>
  error instanceof ArtefactRefusal || (error instanceof Error && error.name === 'ArtefactRefusal')

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({
        capability: 'artefacts',
        message: error instanceof Error && error.message ? error.message : String(error)
      })

/** A call that may be refused: the refusal with its sentence, else unavailable. */
const call = <A>(
  run: (port: ArtefactsService) => A | Promise<A>
): Effect.Effect<A, ArtefactRefused | CapabilityUnavailable, ArtefactsPort> =>
  Effect.flatMap(ArtefactsPort, (port) =>
    Effect.tryPromise({
      try: async () => run(port),
      catch: (error): ArtefactRefused | CapabilityUnavailable =>
        isRefusal(error) ? new ArtefactRefused({ message: error.message }) : unavailable(error)
    })
  )

/** A call the contract declares only unavailable for. */
const plain = <A>(
  run: (port: ArtefactsService) => A | Promise<A>
): Effect.Effect<A, CapabilityUnavailable, ArtefactsPort> =>
  Effect.flatMap(ArtefactsPort, (port) =>
    Effect.tryPromise({ try: async () => run(port), catch: unavailable })
  )

export const artefactHandlers = [
  QueryHandler.make(ListArtefacts, () => plain((a) => a.list())),
  QueryHandler.make(GetSlidelessState, () => plain((a) => a.slidelessState())),
  CommandHandler.make(OpenArtefact, (p) => call((a) => a.open(p.sessionId, p.path))),
  CommandHandler.make(CloseArtefact, (p) => plain((a) => a.close(p.sessionId))),
  CommandHandler.make(HoldArtefactPreview, (p) =>
    call((a) => (p.holdId === undefined ? a.hold(p.sessionId) : a.hold(p.sessionId, p.holdId)))
  ),
  CommandHandler.make(ReleaseArtefactPreview, (p) =>
    plain((a) => a.release(p.sessionId, p.holdId))
  ),
  CommandHandler.make(SaveArtefactVersion, (p) => call((a) => a.saveVersion(p.sessionId))),
  QueryHandler.make(ListArtefactVersions, (p) => call((a) => a.versions(p.sessionId))),
  CommandHandler.make(InstallSlideless, () => plain((a) => a.installSlideless()))
] as const
