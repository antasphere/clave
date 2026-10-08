/**
 * What both ends of the terminal wire share: the generated service and
 * messages, the two declared failures as the framework's business failures
 * (a typed error crosses the wire as protobuf bytes, nothing else of an
 * error does), and the token both sides present and check. The terminal
 * process (`src/main/terminal-process/`) imports this file and nothing else
 * of the server, so its bundle carries no HTTP server and no event store.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { Effect, Schema } from 'effect'
import { businessFailure, GrpcError, Metadata, Status } from '@structure-ai/grpc'
import { SpawnRefusedSchema, UnknownTerminalSchema } from './proto/terminals_pb'

export * from './proto/terminals_pb'

/** The spawn itself failed on the process's side (a directory that does not
 *  exist, a file that cannot run): the reason, as node-pty said it. */
export class SpawnRefused extends Schema.TaggedError<SpawnRefused>()('SpawnRefused', {
  reason: Schema.String
}) {}

/** A terminal the process does not hold: never spawned, or gone. */
export class UnknownTerminal extends Schema.TaggedError<UnknownTerminal>()('UnknownTerminal', {
  id: Schema.String
}) {}

const spawnRefused = businessFailure(SpawnRefused, {
  encode: (wire) =>
    toBinary(SpawnRefusedSchema, create(SpawnRefusedSchema, { reason: wire.reason })),
  decode: (bytes) => ({
    _tag: 'SpawnRefused' as const,
    reason: fromBinary(SpawnRefusedSchema, bytes).reason
  })
})

const unknownTerminal = businessFailure(UnknownTerminal, {
  encode: (wire) => toBinary(UnknownTerminalSchema, create(UnknownTerminalSchema, { id: wire.id })),
  decode: (bytes) => ({
    _tag: 'UnknownTerminal' as const,
    id: fromBinary(UnknownTerminalSchema, bytes).id
  })
})

/** The failure each method declares, given to `service` on the process's
 *  side and to `makeClient` on the server's: both must name the same ones
 *  or a typed failure arrives as a bare INTERNAL. */
export const terminalFailures = {
  spawn: spawnRefused,
  write: unknownTerminal,
  resize: unknownTerminal,
  kill: unknownTerminal,
  attach: unknownTerminal
} as const

export const AUTHORIZATION = 'authorization'

/** The metadata a call presents. */
export const bearer = (token: string): Metadata =>
  new Metadata({ [AUTHORIZATION]: `Bearer ${token}` })

/** Equal in constant time, whatever the lengths: both sides are hashed first
 *  (the HTTP server's own rule, `../auth.ts`, which this file does not import
 *  so the terminal process's bundle stays without the HTTP server). */
const safeEqual = (presented: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest()
  )

/** The check the process runs on every call, before any handler: a caller
 *  that does not present the token is UNAUTHENTICATED, compared in constant
 *  time. */
export const verifyBearer =
  (token: string) =>
  (request: { readonly metadata: Metadata }): Effect.Effect<{ actor: string }, GrpcError> => {
    const header = request.metadata.text(AUTHORIZATION)
    return header !== undefined && header.startsWith('Bearer ') && safeEqual(header.slice(7), token)
      ? Effect.succeed({ actor: 'clave-server' })
      : Effect.fail(new GrpcError({ code: Status.UNAUTHENTICATED }))
  }
