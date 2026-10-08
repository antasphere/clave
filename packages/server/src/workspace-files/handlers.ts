/**
 * The workspace files domain on the buses: one handler per command and
 * query of the contract, each a call on the `WorkspaceFiles` the server was
 * given. The read's reviewer is the review desk: the disclosure goes out as
 * a server event, the read waits for the answer command. Every error the
 * class throws is a defect (the class answers null and empty lists itself
 * where a file is missing or unreadable); the one declared failure is an
 * answer to a review the desk does not hold.
 */
import { Effect, Runtime } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import {
  AnswerWorkspaceFileReview,
  DiscoverWorkspaceFiles,
  DiscoverWorkspaceFilesRecursive,
  ListTrustedRoots,
  ReadAutoDiscoverConfig,
  ReadWorkspaceFile,
  ReadWorkspaceImage,
  ReviewNotFound,
  TrustWorkspaceRoot,
  UntrustWorkspaceRoot,
  UnwatchWorkspaceFile,
  WatchWorkspaceFile,
  WorkspaceFileExists,
  WriteWorkspaceFile
} from '@clave/contract/workspace-files'
import { ServerEvents } from '../events'
import type { WorkspaceFiles } from './files'
import { WorkspaceFilesPort } from './port'
import { ReviewDesk } from './reviews'

/** One call on the instance; anything it throws is a defect. */
const call = <A>(
  run: (files: WorkspaceFiles) => A | Promise<A>
): Effect.Effect<A, never, WorkspaceFilesPort> =>
  Effect.flatMap(WorkspaceFilesPort, (files) => Effect.promise(async () => await run(files)))

export const workspaceFilesHandlers = [
  CommandHandler.make(ReadWorkspaceFile, (p) =>
    Effect.gen(function* () {
      const files = yield* WorkspaceFilesPort
      const desk = yield* ReviewDesk
      const events = yield* ServerEvents
      const runtime = yield* Effect.runtime<never>()
      return yield* Effect.promise(() =>
        files.read(p.path, {
          rootDir: p.rootDir,
          reviewer: (request) =>
            desk.ask(request, (reviewId) =>
              Runtime.runPromise(runtime)(
                events.publish({
                  _tag: 'workspace_files.review_needed',
                  reviewId,
                  requestId: p.requestId ?? null,
                  path: request.path,
                  folder: request.folder,
                  autoCommands: request.autoCommands,
                  prompts: request.prompts,
                  dangerous: request.dangerous
                })
              ).then(() => undefined)
            )
        })
      )
    })
  ),
  CommandHandler.make(WriteWorkspaceFile, (p) => call((f) => f.write(p.path, p.data, p.rootDir))),
  CommandHandler.make(WatchWorkspaceFile, (p) => call((f) => f.watch(p.path))),
  CommandHandler.make(UnwatchWorkspaceFile, (p) => call((f) => f.unwatch(p.path))),
  QueryHandler.make(WorkspaceFileExists, (p) => call((f) => f.exists(p.path))),
  QueryHandler.make(DiscoverWorkspaceFiles, (p) => call((f) => f.discover(p.folder))),
  QueryHandler.make(DiscoverWorkspaceFilesRecursive, (p) =>
    call((f) =>
      f.discoverRecursive(p.rootDir, {
        ...(p.patterns !== undefined && { patterns: p.patterns }),
        ...(p.exclude !== undefined && { exclude: p.exclude }),
        ...(p.maxDepth !== undefined && { maxDepth: p.maxDepth }),
        ...(p.workspaceId !== undefined && { workspaceId: p.workspaceId })
      })
    )
  ),
  QueryHandler.make(ReadAutoDiscoverConfig, (p) => call((f) => f.readAutoDiscover(p.path))),
  QueryHandler.make(ReadWorkspaceImage, (p) => call((f) => f.readImage(p.path))),
  CommandHandler.make(TrustWorkspaceRoot, (p) => call((f) => f.trustRoot(p.root))),
  CommandHandler.make(UntrustWorkspaceRoot, (p) => call((f) => f.untrustRoot(p.root))),
  QueryHandler.make(ListTrustedRoots, () => call((f) => f.listTrustedRoots())),
  CommandHandler.make(AnswerWorkspaceFileReview, (p) =>
    Effect.flatMap(ReviewDesk, (desk) =>
      desk.answer(p.reviewId, { response: p.response, checkboxChecked: p.checkboxChecked })
        ? Effect.void
        : Effect.fail(new ReviewNotFound({ reviewId: p.reviewId }))
    )
  )
] as const
