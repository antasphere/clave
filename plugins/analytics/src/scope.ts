/**
 * The scopes the pages are drawn for, and the keys they are kept under: the live stream's
 * parameter, the deck folders, the open route. Alone in its module so the page script,
 * bundled for the browser, can import it without the ledger's node-side dependencies.
 */
export type ScopeKind = 'session' | 'group' | 'workspace'

export type Scope =
  | { kind: 'session'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'workspace'; ws: string | null }

export type Range = 'all' | 'today' | '7d' | '30d'
export const RANGES: readonly Range[] = ['today', '7d', '30d', 'all']

export function isRange(value: unknown): value is Range {
  return typeof value === 'string' && (RANGES as readonly string[]).includes(value)
}

/** The scope's key: `session:<id>`, `group:<id>`, `workspace:<ws|->`. */
export function scopeKey(kind: ScopeKind, id: string | null): string {
  return kind === 'workspace' ? `workspace:${id ?? '-'}` : `${kind}:${id ?? ''}`
}

export function scopeParam(scope: Scope): string {
  return scopeKey(scope.kind, scope.kind === 'workspace' ? scope.ws : scope.id)
}

export function parseScopeParam(value: string | null): Scope | null {
  if (!value) return null
  const at = value.indexOf(':')
  if (at < 0) return null
  const kind = value.slice(0, at)
  const id = value.slice(at + 1)
  if (kind === 'workspace') return { kind, ws: id === '-' || id === '' ? null : id }
  if ((kind === 'session' || kind === 'group') && id) return { kind, id }
  return null
}

/** The range a page opens on: today for the workspace, everything for a session or a group. */
export function defaultRange(scope: Scope): Range {
  return scope.kind === 'workspace' ? 'today' : 'all'
}

/** The path of a scope's page under a root, with its query: `session/<id>`,
 *  `group/<id>?range=`, `workspace?ws=&range=`. The range is written when given. */
export function scopePath(scope: Scope, range: Range | null): string {
  const query = new URLSearchParams()
  if (scope.kind === 'workspace' && scope.ws) query.set('ws', scope.ws)
  if (range) query.set('range', range)
  const path =
    scope.kind === 'workspace' ? 'workspace' : `${scope.kind}/${encodeURIComponent(scope.id)}`
  const q = query.toString()
  return `${path}${q ? `?${q}` : ''}`
}
