/**
 * Which session records a WINDOW brings back at boot (PRDCT-1703, moved here
 * for PRDCT-3376): its own, stamped with its key, plus, for the primary, the
 * orphans: records with no stamp (written before windows existed) and records
 * stamped for a window that no longer exists (persisted nowhere, live
 * nowhere). The rule needs what only the shell knows, the windows, so it is
 * applied on the shell's side of the wire whatever road the records took:
 * main's IPC handler applies it to main's own listing, and the preload
 * applies it to the server's listing from a scope main answers over IPC.
 * Pure, so one test pins it for both roads.
 */
export interface AdoptionScope {
  /** The asking window's persisted key. */
  windowKey: string
  /** Whether that window is the primary, the one that takes the orphans. */
  primary: boolean
  /** Every window that exists: live now, or persisted for the next boot. */
  knownWindowKeys: ReadonlyArray<string>
}

export interface ScopedRecord {
  windowKey?: string
}

export function selectAdoptableRecords<R extends ScopedRecord>(
  records: ReadonlyArray<R>,
  scope: AdoptionScope
): R[] {
  if (!scope.primary) return records.filter((r) => r.windowKey === scope.windowKey)
  const known = new Set(scope.knownWindowKeys)
  return records.filter(
    (r) => r.windowKey === scope.windowKey || !r.windowKey || !known.has(r.windowKey)
  )
}

/** The session ids a window's saved sidebar layout names: its top-level
 *  tabs, its groups' members and its groups' quick-launch terminals. The
 *  attached restore top-up (`AppShell`) runs only when this is non-empty — a
 *  window that reopens with nothing to bring back must not reach the server at
 *  boot, since that first connect would fire every server-event listener's
 *  catch-up over the state the window has just loaded (PRDCT-3376, PRDCT-3405).
 *  Pure, so one test pins what counts (a group-terminal-only window counts). */
export interface SavedLayoutLike {
  displayOrder: ReadonlyArray<string>
  groups: ReadonlyArray<{
    sessionIds: ReadonlyArray<string>
    terminals: ReadonlyArray<{ sessionId: string | null }>
  }>
}

export function savedLayoutSessionIds(layout: SavedLayoutLike): string[] {
  const ids = new Set<string>(layout.displayOrder)
  for (const g of layout.groups) {
    for (const sid of g.sessionIds) ids.add(sid)
    for (const t of g.terminals) if (t.sessionId) ids.add(t.sessionId)
  }
  return [...ids]
}
