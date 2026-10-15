/**
 * Two answers main gives a window at its boot, without ever freezing on the
 * login shell (PRDCT-3527). Kept apart from the IPC registration so the rule
 * is tested on its own: the handlers in `pty-handlers.ts` pass the real
 * session host, tmux probe and launch decision.
 */
export interface BootReadDeps<R> {
  /** The launch put the sessions on a server process of their own. */
  readonly external: () => boolean
  /** Resolves once tmux can be found without the synchronous login-shell read. */
  readonly tmuxResolvable: () => Promise<void>
  /** The host's adoptable records, every one or those ids. */
  readonly list: (ids?: string[]) => R[]
  /** This window's share of the listing (the adoption scope's rule). */
  readonly scoped: (all: R[]) => R[]
}

/**
 * The records a window brings back over IPC. A read by ids is the re-home
 * path and is always answered. The boot read (no ids) of a shell whose
 * sessions live on a server of their own answers nothing: main's folder holds
 * what an earlier in-process launch left, and offering it brought closed tabs
 * back and asked twice per launch; the window's sessions come from the server.
 */
export async function adoptableRecordsFor<R>(
  filter: { ids?: unknown } | undefined,
  deps: BootReadDeps<R>
): Promise<R[]> {
  const ids =
    filter && Array.isArray(filter.ids)
      ? filter.ids.filter((x): x is string => typeof x === 'string')
      : null
  if (!ids && deps.external()) return []
  await deps.tmuxResolvable()
  return ids ? deps.list(ids) : deps.scoped(deps.list())
}

/** Whether tmux is there, answered once it can be without the synchronous read. */
export async function tmuxAvailableFor(deps: {
  readonly tmuxResolvable: () => Promise<void>
  readonly available: () => boolean
}): Promise<boolean> {
  await deps.tmuxResolvable()
  return deps.available()
}

/**
 * Whether the server holds a record this window would bring back. A window
 * whose saved layout names no session asks this before its restore: the
 * restore connects the window to the server, and a connect made at the boot
 * mark lays the server's copy of the state over the one the window has just
 * loaded (PRDCT-3405), for nothing when there is nothing to restore. A read
 * that fails answers yes, so the restore still tries.
 */
export async function serverHoldsRecordsFor<R>(deps: {
  readonly list: () => Promise<readonly R[]>
  readonly scoped: (all: R[]) => R[]
}): Promise<boolean> {
  try {
    return deps.scoped([...(await deps.list())]).length > 0
  } catch {
    return true
  }
}
