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
