/**
 * The key a scope is kept under: the published decks in the ledger, the live stream's
 * parameter, the publish request. Alone in its module so the page script, bundled for the
 * browser, can import it without the ledger's node-side dependencies.
 */
export type ScopeKind = 'session' | 'group' | 'workspace'

export function scopeKey(kind: ScopeKind, id: string | null): string {
  return kind === 'workspace' ? `workspace:${id ?? '-'}` : `${kind}:${id ?? ''}`
}
