/**
 * The clients domain: the programs attached to a Clave server. The Electron
 * shell registers itself at boot with its pid (lane F's ADR 0003 names that
 * as what the shell expects of the server); a second client later does the
 * same, which is how the server can tell who is listening.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'

export const ClientKind = Schema.Literal('shell', 'browser', 'agent', 'other')
export type ClientKind = typeof ClientKind.Type

export const Client = Schema.Struct({
  /** Minted by the server at registration. */
  id: Schema.NonEmptyString,
  kind: ClientKind,
  /** How the client names itself (`clave-shell 2.0.0`). */
  name: Schema.NonEmptyString,
  /** The client's process id, when it is a process on this machine. */
  pid: Schema.optional(Schema.NonNegativeInt),
  /** Epoch milliseconds, the server's clock. */
  registeredAt: Schema.Number
})
export type Client = typeof Client.Type

/** No client carries that id on this server. */
export class ClientNotFound extends Schema.TaggedError<ClientNotFound>()('ClientNotFound', {
  id: Schema.String
}) {}

/** Register a program attached to this server; the answer carries its id. */
export const RegisterClient = Command.define('RegisterClient', {
  payload: Schema.Struct({
    kind: ClientKind,
    name: Schema.NonEmptyString,
    pid: Schema.optional(Schema.NonNegativeInt)
  }),
  success: Client
})
/** Forget a registered client, on its way out. */
export const UnregisterClient = Command.define('UnregisterClient', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: ClientNotFound
})
/** Every client registered, oldest first. */
export const ListClients = Query.define('ListClients', {
  payload: Schema.Struct({}),
  success: Schema.Array(Client)
})
