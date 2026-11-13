/**
 * Settings domain: provider connections (PRDCT-4426). A provider connection
 * is a key stored once by Clave for a company's coding plan or API (Moonshot,
 * Z.ai, Mistral, …), a local Ollama, or a generic endpoint; it is sealed
 * behind the machine's secret port and listed as a card in Settings →
 * Connections, on the Mac and on a Clave server. The open harnesses (Pi,
 * OpenCode) run on it through the wire formats its endpoints speak.
 *
 * `src/main/provider-connections.ts` is the manager; the catalogue is plain
 * data in `./provider-catalogue` (no import, so the renderer can bundle it),
 * re-exported here for main and the server.
 *
 * NO SCHEMA HERE MAY CARRY A SECRET. A provider key travels in one direction
 * only, client to server, in one payload, `SetProviderConnectionKey`. No
 * event, no query result and no other command success carries it: a
 * connection says `hasKey`.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'
import { PROVIDER_COMPANY_IDS, PROVIDER_WIRE_FORMATS } from './provider-catalogue'

// The catalogue (plain data, no import) lives in `./provider-catalogue`.
export * from './provider-catalogue'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The wire format an endpoint speaks. */
export const ProviderWireFormat = Schema.Literal(...PROVIDER_WIRE_FORMATS)
export type ProviderWireFormat = typeof ProviderWireFormat.Type

/** The ten cards: nine companies of the catalogue and one generic endpoint. */
export const ProviderCompanyId = Schema.Literal(...PROVIDER_COMPANY_IDS)
export type ProviderCompanyId = typeof ProviderCompanyId.Type

export const ProviderEndpoint = Schema.Struct({
  wireFormat: ProviderWireFormat,
  baseUrl: Schema.String
})
export type ProviderEndpoint = typeof ProviderEndpoint.Type

/** A stored provider connection, as every client sees it. Never the key. */
export const ProviderConnectionView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  company: ProviderCompanyId,
  /** The kind of connection in the shared definition of a connection (PRDCT-4493): a key, never a subscription signed in. */
  kind: Schema.Literal('key'),
  /** The pool this connection belongs to: the company's id. */
  pool: ProviderCompanyId,
  endpoints: Schema.Array(ProviderEndpoint),
  /** False for Ollama, which takes no key. */
  needsKey: Schema.Boolean,
  hasKey: Schema.Boolean,
  keySetAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number
})
export type ProviderConnectionView = typeof ProviderConnectionView.Type

// ---------------------------------------------------------------------------
// Queries and commands
// ---------------------------------------------------------------------------

/** Every provider connection of the machine, never a key. */
export const ListProviderConnections = Query.define('ListProviderConnections', {
  payload: Schema.Struct({}),
  success: Schema.Array(ProviderConnectionView)
})

/** A new card: a company of the catalogue, Ollama at a base URL, or a generic endpoint. */
export const AddProviderConnection = Command.define('AddProviderConnection', {
  payload: Schema.Struct({
    company: ProviderCompanyId,
    label: Schema.optional(Schema.String),
    baseUrl: Schema.optional(Schema.String),
    wireFormat: Schema.optional(ProviderWireFormat)
  }),
  success: ProviderConnectionView,
  failure: RefusedOrUnavailable
})

export const RenameProviderConnection = Command.define('RenameProviderConnection', {
  payload: Schema.Struct({ id: Schema.String, label: Schema.String }),
  success: ProviderConnectionView,
  failure: RefusedOrUnavailable
})

/** Removing a connection forgets its key with it. */
export const RemoveProviderConnection = Command.define('RemoveProviderConnection', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Boolean,
  failure: RefusedOrUnavailable
})

/** The one payload a provider key travels in, redacted; the answer says `hasKey`. */
export const SetProviderConnectionKey = Command.define('SetProviderConnectionKey', {
  payload: Schema.Struct({ id: Schema.String, apiKey: Schema.Redacted(Schema.String) }),
  success: ProviderConnectionView,
  failure: RefusedOrUnavailable
})

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The whole list after any change, never a key. */
export const ProviderConnectionsChanged = Schema.TaggedStruct('accounts.providers_changed', {
  connections: Schema.Array(ProviderConnectionView)
})
