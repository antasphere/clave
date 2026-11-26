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
  AddSlidelessSite,
  AnswerSlidelessSignIn,
  ArtefactRefused,
  CancelSlidelessSignIn,
  CheckSlidelessAccounts,
  CloseArtefact,
  GetArtefactDeck,
  GetSlidelessState,
  HoldArtefactPreview,
  InstallSlideless,
  ListArtefacts,
  ListArtefactVersions,
  ListSlidelessAccounts,
  OpenArtefact,
  PasteSlidelessKey,
  ReleaseArtefactPreview,
  RevokeArtefactLink,
  RunSlidelessFix,
  SaveArtefactVersion,
  SetNewLinksSite,
  ShareArtefact,
  StartSlidelessSignIn
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
  CommandHandler.make(OpenArtefact, (p) =>
    call((a) =>
      p.present === true ? a.open(p.sessionId, p.path, true) : a.open(p.sessionId, p.path)
    )
  ),
  CommandHandler.make(CloseArtefact, (p) =>
    plain((a) => (p.target === undefined ? a.close(p.sessionId) : a.close(p.sessionId, p.target)))
  ),
  CommandHandler.make(HoldArtefactPreview, (p) =>
    call((a) =>
      p.target !== undefined
        ? a.hold(p.sessionId, p.holdId, p.target)
        : p.holdId === undefined
          ? a.hold(p.sessionId)
          : a.hold(p.sessionId, p.holdId)
    )
  ),
  CommandHandler.make(ReleaseArtefactPreview, (p) =>
    plain((a) => a.release(p.sessionId, p.holdId))
  ),
  CommandHandler.make(SaveArtefactVersion, (p) =>
    call((a) =>
      p.target === undefined ? a.saveVersion(p.sessionId) : a.saveVersion(p.sessionId, p.target)
    )
  ),
  QueryHandler.make(ListArtefactVersions, (p) =>
    call((a) =>
      p.target === undefined ? a.versions(p.sessionId) : a.versions(p.sessionId, p.target)
    )
  ),
  CommandHandler.make(InstallSlideless, () => plain((a) => a.installSlideless())),
  // ── PRDCT-4266: the Slideless accounts of the server's machine ──
  QueryHandler.make(ListSlidelessAccounts, () => call((a) => a.slidelessAccounts())),
  CommandHandler.make(CheckSlidelessAccounts, () => call((a) => a.checkSlidelessAccounts())),
  CommandHandler.make(AddSlidelessSite, (p) => call((a) => a.addSlidelessSite(p.url))),
  CommandHandler.make(SetNewLinksSite, (p) => call((a) => a.setNewLinksSite(p.origin))),
  CommandHandler.make(RunSlidelessFix, (p) => call((a) => a.runSlidelessFix(p.origin, p.kind))),
  // The address and the hub are passed on only when they are given.
  CommandHandler.make(StartSlidelessSignIn, (p) =>
    call((a) =>
      a.startSlidelessSignIn(p.origin, {
        ...(p.email !== undefined && { email: p.email }),
        ...(p.hub !== undefined && { hub: p.hub })
      })
    )
  ),
  CommandHandler.make(AnswerSlidelessSignIn, (p) =>
    call((a) => a.answerSlidelessSignIn(p.id, p.code))
  ),
  CommandHandler.make(CancelSlidelessSignIn, (p) => plain((a) => a.cancelSlidelessSignIn(p.id))),
  CommandHandler.make(PasteSlidelessKey, (p) => call((a) => a.pasteSlidelessKey(p.origin, p.key))),
  // ── PRDCT-4266: an artefact's deck and its links ──
  QueryHandler.make(GetArtefactDeck, (p) => call((a) => a.artefactDeck(p.sessionId, p.target))),
  CommandHandler.make(ShareArtefact, (p) =>
    call((a) =>
      a.shareArtefact(p.sessionId, p.target, {
        ...(p.site !== undefined && { site: p.site }),
        ...(p.newDeck !== undefined && { newDeck: p.newDeck }),
        ...(p.title !== undefined && { title: p.title }),
        link: p.link
      })
    )
  ),
  CommandHandler.make(RevokeArtefactLink, (p) =>
    call((a) => a.revokeArtefactLink(p.sessionId, p.target, p.tokenId))
  )
] as const
