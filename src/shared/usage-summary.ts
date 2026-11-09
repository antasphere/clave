/**
 * An account's last usage read, summarized for the pool (`account-pool.ts`)
 * and for every readout: the caps SPLIT the way the service meters them.
 *
 * Anthropic meters a subscription per account AND model family: shared caps
 * (the 5-hour block where the plan still has one, the weekly all-models cap)
 * and one weekly cap per family (Fable, Opus, Sonnet), the service's
 * `weekly_scoped` kind with the family as its `scope`. A family cap that is
 * out stops the sessions on that family and nothing else, so the summary
 * keeps the two apart:
 *
 * - `shared` is the tightest shared window, `scoped` one entry per family
 *   with its own `exhausted` word, `scopedOut` the families whose cap is out.
 * - `tightest` is the window about to stop THE VIEW THE SUMMARY DESCRIBES:
 *   for an account (no model context) the tightest SHARED window, never a
 *   family's; for a session (`usageSummaryForModel`) the tightest over the
 *   shared windows and the session's own family cap. `isExhausted` reads it,
 *   so an account view is exhausted by a shared cap alone and a session view
 *   by a shared cap or its family's.
 *
 * Main builds it from the usage manager's read (in-process) and from the
 * server's snapshot (attached); the renderer's store builds the same from
 * its resources through the same functions, so no copy of the rule drifts.
 */
import {
  windowExhausted,
  type AccountUsageSummary,
  type PoolUsageWindow,
  type ScopedCap
} from './account-pool'

interface ReadLike {
  windows?: ReadonlyArray<PoolUsageWindow>
}

const rank: Record<string, number> = { normal: 0, warning: 1, critical: 2 }

/** The service's kind for a cap scoped to one model family. */
export const SCOPED_KIND = 'weekly_scoped'

/** A cap every model of the account draws on: the 5-hour block, the weekly
 *  all-models cap, and whatever kind the service adds that names no family. */
export function isSharedWindow(w: PoolUsageWindow): boolean {
  return w.kind !== SCOPED_KIND
}

/** The family a model id belongs to among the families the read names, by
 *  the model's own tokens (`claude-fable-5-1` → `Fable`), or null when the
 *  model names none of them. */
export function familyOfModel(
  windows: ReadonlyArray<PoolUsageWindow>,
  model?: string
): string | null {
  const tokens =
    model
      ?.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean) ?? []
  for (const w of windows) {
    if (w.kind !== SCOPED_KIND) continue
    const scope = w.scope?.trim()
    if (scope && tokens.includes(scope.toLowerCase())) return scope
  }
  return null
}

/** Shared caps and caps whose model is explicitly known to this session.
 *  With no model, the shared caps alone: a family cap belongs to the
 *  sessions on that family, and an account view names it through `scoped`. */
export function usageWindowsForModel<W extends PoolUsageWindow>(
  windows: ReadonlyArray<W>,
  model?: string
): W[] {
  const family = familyOfModel(windows, model)
  return windows.filter((w) => isSharedWindow(w) || (family !== null && w.scope === family))
}

export function tightestOf<W extends PoolUsageWindow>(windows: ReadonlyArray<W>): W | null {
  let best: W | null = null
  for (const w of windows) {
    if (!best) best = w
    else {
      const a = rank[w.severity ?? 'normal'] ?? 0
      const b = rank[best.severity ?? 'normal'] ?? 0
      if (a > b || (a === b && w.usedPercentage > best.usedPercentage)) best = w
    }
  }
  return best
}

/** One entry per family the read names, the tighter window when a read
 *  carries two for one family, in the read's order. */
export function scopedCapsOf<W extends PoolUsageWindow>(
  windows: ReadonlyArray<W>
): (ScopedCap & { window: W })[] {
  const byFamily = new Map<string, W>()
  for (const w of windows) {
    if (isSharedWindow(w)) continue
    const family = w.scope?.trim()
    if (!family) continue
    const held = byFamily.get(family)
    byFamily.set(family, held ? (tightestOf([held, w]) ?? w) : w)
  }
  return [...byFamily.entries()].map(([family, window]) => ({
    family,
    window,
    exhausted: windowExhausted(window)
  }))
}

/** The split of a read's windows for a VIEW: `tightest` over the windows
 *  given (the caller has already chosen which belong to the view), `shared`
 *  over the shared ones among them, `scoped` and `scopedOut` from the family
 *  caps among them. */
export function splitWindows<W extends PoolUsageWindow>(
  windows: ReadonlyArray<W>
): {
  tightest: W | null
  shared: W | null
  scoped: (ScopedCap & { window: W })[]
  scopedOut: string[]
} {
  const scoped = scopedCapsOf(windows)
  return {
    tightest: tightestOf(windows),
    shared: tightestOf(windows.filter(isSharedWindow)),
    scoped,
    scopedOut: scoped.filter((cap) => cap.exhausted).map((cap) => cap.family)
  }
}

/** The ACCOUNT view of a read: `tightest` over the shared caps alone, every
 *  family cap under `scoped`. Nothing for no read, or a failed one. */
export function usageSummaryOf(read: ReadLike | undefined | null): AccountUsageSummary | undefined {
  if (!read || !Array.isArray(read.windows)) return undefined
  const windows = [...read.windows]
  const split = splitWindows(windows)
  return { ...split, tightest: tightestOf(windows.filter(isSharedWindow)), windows }
}

/** The SESSION view of a summary: the shared caps plus the cap of the
 *  session's own family, `tightest` over those. With no model, the shared
 *  caps alone. */
export function usageSummaryForModel(
  summary: AccountUsageSummary | undefined,
  model?: string
): AccountUsageSummary | undefined {
  if (!summary) return undefined
  const windows = usageWindowsForModel(
    summary.windows ?? (summary.tightest ? [summary.tightest] : []),
    model
  )
  return { ...splitWindows(windows), windows }
}
