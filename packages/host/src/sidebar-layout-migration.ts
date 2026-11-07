/**
 * The pure half of the sidebar-layout migrations (PRDCT-1703).
 *
 * Pure: no filesystem, no Electron, so vitest pins every partition rule in
 * node. The manager (sidebar-layout-manager.ts) reads the legacy single
 * `sidebar-layout.json`, calls `partitionLegacyLayout` to stamp each group
 * with a workspace, concatenates the partitions (`concatLayouts`) with any
 * per-workspace files the halted one-workspace-per-window build wrote, and
 * writes the result as the FIRST WINDOW's layout, RENAMING every source to
 * `.migrated-backup` — never deleting it.
 *
 * A mis-partitioned layout is the classic silent defect: nothing errors, a
 * group just shows up in the wrong workspace, or in none, days later. That
 * is why the rules live here as testable sentences:
 *
 *   - a group carrying a REGISTERED workspaceId goes to that workspace;
 *   - a group with none (or a stale id) goes to the workspace whose root
 *     contains its cwd, else to the fallback (last-active, else the first
 *     registered);
 *   - every group is stamped with the workspace it landed in, so the
 *     per-workspace file is self-describing;
 *   - a displayOrder id that names a group follows that group;
 *   - a displayOrder id that names a session follows the session's workspace
 *     where the session records know it, else the fallback;
 *   - order inside a partition is the legacy order; nothing is duplicated;
 *   - every group lands in EXACTLY ONE partition.
 */
export interface SidebarLayoutData {
  groups: unknown[]
  displayOrder: string[]
}

export interface PartitionContext {
  /** Registered workspace ids at migration time. */
  workspaceIds: string[]
  /** Where an unplaceable item goes: lastActiveWorkspaceId, else the first
   *  registered workspace. The caller guarantees it is registered. */
  fallbackWorkspaceId: string
  /** `workspaceManager.resolveWorkspaceForCwd` — longest registered root
   *  containing cwd, or null. */
  resolveWorkspaceForCwd: (cwd: string) => string | null
  /** Workspace of a session id from its record (stamped, else cwd-derived),
   *  or null when no record knows it. */
  resolveWorkspaceForSession: (sessionId: string) => string | null
}

interface GroupLike {
  id?: unknown
  workspaceId?: unknown
  cwd?: unknown
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Split a legacy `{groups, displayOrder}` into one layout per workspace. */
export function partitionLegacyLayout(
  legacy: SidebarLayoutData,
  ctx: PartitionContext
): Map<string, SidebarLayoutData> {
  const registered = new Set(ctx.workspaceIds)
  const place = (g: GroupLike): string => {
    if (typeof g.workspaceId === 'string' && registered.has(g.workspaceId)) return g.workspaceId
    const byCwd = typeof g.cwd === 'string' && g.cwd ? ctx.resolveWorkspaceForCwd(g.cwd) : null
    return byCwd && registered.has(byCwd) ? byCwd : ctx.fallbackWorkspaceId
  }

  const out = new Map<string, SidebarLayoutData>()
  const bucket = (ws: string): SidebarLayoutData => {
    let b = out.get(ws)
    if (!b) {
      b = { groups: [], displayOrder: [] }
      out.set(ws, b)
    }
    return b
  }

  const groupWorkspace = new Map<string, string>()
  const seenGroupIds = new Set<string>()
  for (const raw of Array.isArray(legacy.groups) ? legacy.groups : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string') continue
    if (seenGroupIds.has(raw.id)) continue
    seenGroupIds.add(raw.id)
    const ws = place(raw)
    groupWorkspace.set(raw.id, ws)
    bucket(ws).groups.push({ ...raw, workspaceId: ws })
  }

  const seenOrderIds = new Set<string>()
  for (const id of Array.isArray(legacy.displayOrder) ? legacy.displayOrder : []) {
    if (typeof id !== 'string' || seenOrderIds.has(id)) continue
    seenOrderIds.add(id)
    const ws =
      groupWorkspace.get(id) ??
      (() => {
        const bySession = ctx.resolveWorkspaceForSession(id)
        return bySession && registered.has(bySession) ? bySession : ctx.fallbackWorkspaceId
      })()
    bucket(ws).displayOrder.push(id)
  }

  return out
}

/** Fold a migrated partition into a per-workspace file that already exists
 *  (a workspace registered mid-run already wrote one): the existing file
 *  wins on conflicts, incoming groups and order entries are appended only
 *  when their id is absent. */
export function mergeLayouts(
  existing: SidebarLayoutData,
  incoming: SidebarLayoutData
): SidebarLayoutData {
  const knownGroupIds = new Set(
    existing.groups
      .filter(isRecord)
      .map((g) => g.id)
      .filter((id): id is string => typeof id === 'string')
  )
  const groups = [...existing.groups]
  for (const g of incoming.groups) {
    if (isRecord(g) && typeof g.id === 'string' && knownGroupIds.has(g.id)) continue
    groups.push(g)
  }
  const knownOrder = new Set(existing.displayOrder)
  const displayOrder = [...existing.displayOrder]
  for (const id of incoming.displayOrder) {
    if (knownOrder.has(id)) continue
    knownOrder.add(id)
    displayOrder.push(id)
  }
  return { groups, displayOrder }
}

/** Concatenate several workspaces' layouts into the single in-memory shape
 *  the renderer store holds (one flat groups array, one display order). Order
 *  of the inputs is the order of the concatenation; ids are deduplicated the
 *  same way `mergeLayouts` does. */
export function concatLayouts(layouts: SidebarLayoutData[]): SidebarLayoutData {
  return layouts.reduce<SidebarLayoutData>((acc, l) => mergeLayouts(acc, l), {
    groups: [],
    displayOrder: []
  })
}
