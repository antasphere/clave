/**
 * An account's last usage read, summarized for the pool (`account-pool.ts`):
 * the tightest window (the most severe, then the most used) and the windows
 * themselves; nothing for no read, or a failed one. Main builds it from the
 * usage manager's read (in-process) and from the server's snapshot
 * (attached); the renderer's store builds the same from its resources.
 */
import type { AccountUsageSummary, PoolUsageWindow } from './account-pool'

interface ReadLike {
  windows?: ReadonlyArray<PoolUsageWindow>
}

const rank: Record<string, number> = { normal: 0, warning: 1, critical: 2 }

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

export function usageSummaryOf(read: ReadLike | undefined | null): AccountUsageSummary | undefined {
  if (!read || !Array.isArray(read.windows)) return undefined
  return { tightest: tightestOf(read.windows), windows: [...read.windows] }
}
