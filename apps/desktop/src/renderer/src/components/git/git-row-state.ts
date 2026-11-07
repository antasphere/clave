import { useCallback, useState } from 'react'

/**
 * Which repository rows of the git list are open, and which of their sections
 * (PRDCT-4142). The state lives outside the rows, keyed by repository path:
 * the list is rebuilt whenever the panel's folder changes, and a row that
 * comes back for the same repository opens as it was left, rather than folded.
 *
 * `incoming` and `outgoing` are the ↓ ↑ sections, `base` and `worktree` a
 * worktree row's two purple sections (PRDCT-2356: what its base gained since
 * the cut, and what the worktree added), `changes` the local work, on from the
 * start since it is what the row unfolds INTO once opened, not whether it is
 * open. A row starts CLOSED, whatever it is carrying (see MultiRepoSection).
 */
export interface RowState {
  expanded: boolean
  incoming: boolean
  outgoing: boolean
  base: boolean
  worktree: boolean
  changes: boolean
}

export const ROW_DEFAULT: RowState = {
  expanded: false,
  incoming: false,
  outgoing: false,
  base: false,
  worktree: false,
  changes: true
}

const rowStateCache = new Map<string, RowState>()

/** The remembered state of a row, as the next mount of it will read it. */
export function rememberedRowState(repoPath: string): RowState {
  return rowStateCache.get(repoPath) ?? ROW_DEFAULT
}

/** Forget every row (tests). */
export function resetRowStates(): void {
  rowStateCache.clear()
}

export type RowPatch = Partial<RowState> | ((prev: RowState) => Partial<RowState>)

export function useRowState(repoPath: string): [RowState, (patch: RowPatch) => void] {
  const [state, setState] = useState<RowState>(() => rememberedRowState(repoPath))
  const update = useCallback(
    (patch: RowPatch) => {
      setState((prev) => {
        const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
        rowStateCache.set(repoPath, next)
        return next
      })
    },
    [repoPath]
  )
  return [state, update]
}
