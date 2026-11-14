/**
 * A stored provider connection's usage line as a window reads it (PRDCT-4496):
 * a figure where the provider documents how to read what is left, "Pay per
 * use", "Coding plan" or "Local" otherwise, and "Usage unknown" with its
 * reason. The host (this Mac's main, or a Clave server) reads it; this is the
 * shape it answers on both roads, IPC and the server's `ReadProviderUsage`.
 *
 * ZERO imports, on its own subpath (`@clave/contract/settings/provider-usage-view`):
 * the window loads this module at value level, and a module that reaches
 * `@structure-ai/cqrs` or Effect breaks the renderer's build. The Effect
 * schemas are built from these constants in `provider-usage.ts`.
 */

/** The kinds of usage line, one per thing a connection can say. */
export const PROVIDER_USAGE_KINDS = [
  'balance',
  'limit',
  'used',
  'payPerUse',
  'plan',
  'local',
  'unknown'
] as const
export type ProviderUsageKind = (typeof PROVIDER_USAGE_KINDS)[number]

export type ProviderUsageLineView =
  | { kind: 'balance'; left: string; currency: string }
  | { kind: 'limit'; left: string; of: string; currency: string }
  | { kind: 'used'; used: string; currency: string }
  | { kind: 'payPerUse' }
  | { kind: 'plan' }
  | { kind: 'local' }
  | { kind: 'unknown'; reason: string }

/** The line as the person reads it. */
export function usageLineText(line: ProviderUsageLineView): string {
  switch (line.kind) {
    case 'balance':
      return `${line.left} ${line.currency} left`
    case 'limit':
      return `${line.left} of ${line.of} ${line.currency} left`
    case 'used':
      return `Pay per use · ${line.used} ${line.currency} used`
    case 'payPerUse':
      return 'Pay per use'
    case 'plan':
      return 'Coding plan'
    case 'local':
      return 'Local'
    case 'unknown':
      return 'Usage unknown'
  }
}
