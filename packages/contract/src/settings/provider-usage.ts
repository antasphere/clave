/**
 * Settings domain: a stored provider connection's usage line (PRDCT-4496).
 * The host (this Mac's server, or a saved Clave server) holds the connection
 * and its key, reads the provider's documented endpoint on demand, caches the
 * line five minutes, and answers it, so a window attached to a server reads
 * what THAT server's connection says.
 *
 * The view's plain shape and its constants live in `provider-usage-view.ts`,
 * which the window loads; the schemas here are built from them.
 *
 * Mirrors `src/main/provider-usage.ts`, the reader on the host.
 */
import { Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'
import { PROVIDER_USAGE_KINDS } from './provider-usage-view'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const [BALANCE, LIMIT, USED, PAY_PER_USE, PLAN, LOCAL, UNKNOWN] = PROVIDER_USAGE_KINDS

export const ProviderUsageKind = Schema.Literal(...PROVIDER_USAGE_KINDS)

export const ProviderUsageLineView = Schema.Union(
  Schema.Struct({ kind: Schema.Literal(BALANCE), left: Schema.String, currency: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal(LIMIT),
    left: Schema.String,
    of: Schema.String,
    currency: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal(USED), used: Schema.String, currency: Schema.String }),
  Schema.Struct({ kind: Schema.Literal(PAY_PER_USE) }),
  Schema.Struct({ kind: Schema.Literal(PLAN) }),
  Schema.Struct({ kind: Schema.Literal(LOCAL) }),
  /** The reason in the person's words, never the provider's own text. */
  Schema.Struct({ kind: Schema.Literal(UNKNOWN), reason: Schema.String })
)

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** `provider-usage:read` — the usage line of that connection, read again
 *  first with `force`. A query's payload is decoded from the URL: the flag
 *  travels as a string. A connection the host does not know is the unknown
 *  line, never a refusal. */
export const ReadProviderUsage = Query.define('ReadProviderUsage', {
  payload: Schema.Struct({
    connectionId: Schema.String,
    force: Schema.optional(Schema.BooleanFromString)
  }),
  success: ProviderUsageLineView,
  failure: RefusedOrUnavailable
})
