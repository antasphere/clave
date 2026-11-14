/**
 * Settings domain: what Pi and OpenCode tabs used, per connection
 * (PRDCT-4551). The host that runs the tabs (this Mac's server, or a saved
 * Clave server) reads the harnesses' own records, attributes each to the
 * connection its session ran on at that time (its ledger of starts), and
 * answers the rows, so a window attached to a server reads what THAT
 * server's tabs used.
 *
 * The view's plain shape and its constants live in `harness-usage-view.ts`,
 * which the window loads; the schemas here are built from them.
 *
 * Mirrors `src/main/harness-usage.ts`, the reader on the host.
 */
import { Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'
import { HARNESS_USAGE_BILLINGS, HARNESS_USAGE_RANGES, USAGE_HARNESSES } from './harness-usage-view'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const UsageHarness = Schema.Literal(...USAGE_HARNESSES)
export const HarnessUsageRange = Schema.Literal(...HARNESS_USAGE_RANGES)
export const HarnessUsageBilling = Schema.Literal(...HARNESS_USAGE_BILLINGS)

export const HarnessUsageRowView = Schema.Struct({
  harness: UsageHarness,
  connectionId: Schema.NullOr(Schema.String),
  label: Schema.String,
  billing: HarnessUsageBilling,
  removed: Schema.Boolean,
  other: Schema.optional(Schema.Boolean),
  requests: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Number,
  sessions: Schema.Number
})

export const HarnessUsageView = Schema.Struct({
  range: HarnessUsageRange,
  rows: Schema.Array(HarnessUsageRowView),
  unavailable: Schema.Array(Schema.Struct({ harness: UsageHarness, reason: Schema.String })),
  reading: Schema.optional(Schema.Array(UsageHarness))
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** `harness-usage:read` — every Pi and OpenCode connection's usage over the
 *  range, read again first with `force`. A query's payload is decoded from
 *  the URL: the flag travels as a string. */
export const ReadHarnessUsage = Query.define('ReadHarnessUsage', {
  payload: Schema.Struct({
    range: HarnessUsageRange,
    force: Schema.optional(Schema.BooleanFromString)
  }),
  success: HarnessUsageView,
  failure: RefusedOrUnavailable
})
