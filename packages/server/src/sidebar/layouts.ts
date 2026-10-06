/**
 * The sidebar domain on the server: one layout per window key, read from the
 * storage the first time a key is touched and written back on every change.
 * A plain synchronous class on purpose. The rules are the pure ones of
 * `@clave/contract/sidebar/ops`, shared with the renderer; what this file
 * adds is the revision a window's save must name, the hand-overs between
 * windows the shell performs through its port, and one event per change for
 * whoever listens (the handlers turn those into server events).
 */
import { randomUUID } from 'node:crypto'
import type {
  GroupTerminal,
  GroupTerminalPatch,
  GroupView,
  LayoutSnapshot,
  MoveResult,
  NewGroup,
  NewGroupTerminal,
  SidebarEvent,
  SidebarGroup,
  WindowLayout
} from '@clave/contract/sidebar'
import {
  type NormalizedGroup,
  type NormalizedLayout,
  type NormalizedTerminal,
  absorbLayout,
  moveLayoutItems,
  normalizeLayout
} from '@clave/contract/sidebar/ops'
import type { SidebarHost, SidebarStorage } from './ports'

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
export type Unsubscribe = () => void

// The failures as plain tagged objects, not the contract's error classes:
// the Electron shell builds this class at boot, synchronously, and the
// classes would pull Effect into main's static graph. The handlers turn each
// one into its class at the bus.
export interface LayoutConflict {
  readonly _tag: 'LayoutConflict'
  readonly windowKey: string
  readonly current: LayoutSnapshot
}
export interface GroupNotFound {
  readonly _tag: 'GroupNotFound'
  readonly groupId: string
}
export interface TerminalNotFound {
  readonly _tag: 'TerminalNotFound'
  readonly groupId: string
  readonly terminalId: string
}
export interface WindowNotFound {
  readonly _tag: 'WindowNotFound'
  readonly windowKey: string
}
/** The shared failure of `@clave/contract/errors`: this server hosts no windows. */
export interface CapabilityUnavailable {
  readonly _tag: 'CapabilityUnavailable'
  readonly capability: 'sidebar'
  readonly message: string
}
export type SidebarFailure =
  | LayoutConflict
  | GroupNotFound
  | TerminalNotFound
  | WindowNotFound
  | CapabilityUnavailable

const noWindows = (): CapabilityUnavailable => ({
  _tag: 'CapabilityUnavailable',
  capability: 'sidebar',
  message: 'This server hosts no windows: a tab cannot move between windows here.'
})

const groupNotFound = (groupId: string): GroupNotFound => ({ _tag: 'GroupNotFound', groupId })
const windowNotFound = (windowKey: string): WindowNotFound => ({
  _tag: 'WindowNotFound',
  windowKey
})

type Cause = Extract<SidebarEvent, { _tag: 'sidebar.layout_changed' }>['cause']
type Entry = { layout: NormalizedLayout; revision: number }
type MovePosition = 'before' | 'after' | 'inside'

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })
const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error })

/** A copy nobody can write through: the cache stays the server's alone. */
function frozen<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (x: unknown): void => {
    if (typeof x !== 'object' || x === null) return
    Object.freeze(x)
    for (const v of Object.values(x)) freeze(v)
  }
  freeze(copy)
  return copy
}

/** The session ids a group holds: its members, then its terminals' sessions. */
const linkedOf = (group: NormalizedGroup): string[] => [
  ...group.sessionIds,
  ...group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
]

interface HoldingLayout {
  readonly groups: ReadonlyArray<{
    readonly sessionIds: ReadonlyArray<string>
    readonly terminals: ReadonlyArray<{ readonly sessionId: string | null }>
  }>
  readonly displayOrder: ReadonlyArray<string>
}

/** Whether the layout already shows the session: at the top level, as a
 *  group's member, or as a group's running terminal. */
const holds = (layout: HoldingLayout, sessionId: string): boolean =>
  layout.displayOrder.includes(sessionId) ||
  layout.groups.some(
    (g) => g.sessionIds.includes(sessionId) || g.terminals.some((t) => t.sessionId === sessionId)
  )

export class SidebarLayouts {
  private readonly cache = new Map<string, Entry>()
  private readonly listeners = new Set<(event: SidebarEvent) => void>()
  private readonly mintId: () => string

  constructor(
    private readonly storage: SidebarStorage,
    private readonly host: SidebarHost,
    options?: { mintId?: () => string }
  ) {
    this.mintId = options?.mintId ?? randomUUID
  }

  // ── Reads ──

  /** One window's layout. The primary's read also takes in the orphans;
   *  their documents are removed as they are taken, so a second read finds
   *  none and takes nothing. */
  get(windowKey: string): LayoutSnapshot {
    const entry = this.load(windowKey)
    if (this.host.isPrimary(windowKey)) this.takeOrphans(windowKey, entry)
    return this.snapshot(windowKey)
  }

  list(): LayoutSnapshot[] {
    const keys = new Set([...this.cache.keys(), ...this.storage.keys()])
    return [...keys].map((key) => {
      this.load(key)
      return this.snapshot(key)
    })
  }

  // ── The window's own write ──

  save(
    windowKey: string,
    layout: WindowLayout,
    baseRevision?: number
  ): Result<LayoutSnapshot, LayoutConflict> {
    const entry = this.load(windowKey)
    if (baseRevision !== undefined && baseRevision !== entry.revision) {
      return err({ _tag: 'LayoutConflict', windowKey, current: this.snapshot(windowKey) })
    }
    return ok(this.commit(windowKey, normalizeLayout(layout), 'save'))
  }

  // ── Groups ──

  createGroup(windowKey: string, group: NewGroup): { group: SidebarGroup; layout: LayoutSnapshot } {
    const current = this.load(windowKey).layout
    const id = group.id ?? `group-${this.mintId()}`
    const members = [...(group.sessionIds ?? [])]
    const created: NormalizedGroup = {
      id,
      name: group.name,
      sessionIds: members,
      collapsed: false,
      cwd: group.cwd ?? null,
      terminals: (group.terminals ?? []).map((t) => ({ ...t }))
    }
    if (group.prompt !== undefined) created.prompt = group.prompt
    if (group.rootSession !== undefined) created.rootSession = group.rootSession
    if (group.color !== undefined) created.color = group.color
    if (group.view !== undefined) created.view = group.view === null ? null : { ...group.view }
    if (group.workspaceId !== undefined) created.workspaceId = group.workspaceId

    const memberSet = new Set(members)
    // A group of the same id is replaced, never doubled: two groups under
    // one id would make every by-id edit land on the wrong one.
    const others = current.groups
      .filter((g) => g.id !== id)
      .map((g) => ({ ...g, sessionIds: g.sessionIds.filter((sid) => !memberSet.has(sid)) }))
    // The group takes the first member's place at the top level and the
    // other members leave it, as the renderer's createGroup does.
    let inserted = false
    const displayOrder: string[] = []
    for (const entry of current.displayOrder) {
      if (entry === id) continue
      if (memberSet.has(entry)) {
        if (!inserted) {
          inserted = true
          displayOrder.push(id)
        }
      } else displayOrder.push(entry)
    }
    if (!inserted) displayOrder.push(id)

    const layout = this.commit(windowKey, { groups: [...others, created], displayOrder }, 'command')
    const stored = layout.groups.find((g) => g.id === id)!
    return { group: stored, layout }
  }

  renameGroup(
    windowKey: string,
    groupId: string,
    name: string
  ): Result<LayoutSnapshot, GroupNotFound> {
    return this.editGroup(windowKey, groupId, (g) => ({ ...g, name: name.trim() || 'Group' }))
  }

  setGroupView(
    windowKey: string,
    groupId: string,
    view: GroupView | null
  ): Result<LayoutSnapshot, GroupNotFound> {
    const next = view === null ? null : { ...view }
    return this.editGroup(windowKey, groupId, (g) => ({ ...g, view: next }))
  }

  setGroupColor(
    windowKey: string,
    groupId: string,
    color: string | null
  ): Result<LayoutSnapshot, GroupNotFound> {
    return this.editGroup(windowKey, groupId, (g) => ({ ...g, color }))
  }

  setGroupPrompt(
    windowKey: string,
    groupId: string,
    prompt: string | null
  ): Result<LayoutSnapshot, GroupNotFound> {
    return this.editGroup(windowKey, groupId, (g) => ({ ...g, prompt }))
  }

  setGroupCollapsed(
    windowKey: string,
    groupId: string,
    collapsed: boolean
  ): Result<LayoutSnapshot, GroupNotFound> {
    return this.editGroup(windowKey, groupId, (g) => ({ ...g, collapsed }))
  }

  /**
   * `dissolve` puts the members where the group stood, the explicit ungroup;
   * `remove` drops the group and everything it held from the order. Either
   * way the terminals' sessions leave the order, since a quick-launch
   * terminal belongs to its group and stops with it (the renderer's
   * ungroupSessions and deleteGroup, layout part only).
   */
  deleteGroup(
    windowKey: string,
    groupId: string,
    mode: 'dissolve' | 'remove'
  ): Result<LayoutSnapshot, GroupNotFound> {
    const current = this.load(windowKey).layout
    const group = current.groups.find((g) => g.id === groupId)
    if (!group) return err(groupNotFound(groupId))
    const terminalIds = new Set(
      group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
    )
    const groups = current.groups.filter((g) => g.id !== groupId)
    let displayOrder: string[]
    if (mode === 'dissolve') {
      displayOrder = current.displayOrder.filter((id) => !terminalIds.has(id))
      const idx = displayOrder.indexOf(groupId)
      if (idx !== -1) {
        displayOrder.splice(idx, 1, ...group.sessionIds.filter((id) => !terminalIds.has(id)))
      }
    } else {
      const gone = new Set([...group.sessionIds, ...terminalIds])
      displayOrder = current.displayOrder.filter((id) => id !== groupId && !gone.has(id))
    }
    return ok(this.commit(windowKey, { groups, displayOrder }, 'command'))
  }

  // ── Quick-launch terminals ──

  addTerminal(
    windowKey: string,
    groupId: string,
    terminal: typeof NewGroupTerminal.Type
  ): Result<{ terminal: GroupTerminal; layout: LayoutSnapshot }, GroupNotFound> {
    const id = terminal.id ?? `term-${this.mintId()}`
    const added: NormalizedTerminal = { ...terminal, id, sessionId: terminal.sessionId ?? null }
    const result = this.editGroup(windowKey, groupId, (g) => ({
      ...g,
      terminals: [...g.terminals.filter((t) => t.id !== id), added]
    }))
    if (!result.ok) return result
    const stored = result.value.groups
      .find((g) => g.id === groupId)!
      .terminals.find((t) => t.id === id)!
    return ok({ terminal: stored, layout: result.value })
  }

  updateTerminal(
    windowKey: string,
    groupId: string,
    terminalId: string,
    patch: GroupTerminalPatch
  ): Result<LayoutSnapshot, GroupNotFound | TerminalNotFound> {
    const group = this.load(windowKey).layout.groups.find((g) => g.id === groupId)
    if (!group) return err(groupNotFound(groupId))
    if (!group.terminals.some((t) => t.id === terminalId)) {
      return err({ _tag: 'TerminalNotFound', groupId, terminalId })
    }
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as Partial<NormalizedTerminal>
    return this.editGroup(windowKey, groupId, (g) => ({
      ...g,
      terminals: g.terminals.map((t) => (t.id === terminalId ? { ...t, ...defined } : t))
    }))
  }

  removeTerminal(
    windowKey: string,
    groupId: string,
    terminalId: string
  ): Result<LayoutSnapshot, GroupNotFound> {
    return this.editGroup(windowKey, groupId, (g) => ({
      ...g,
      terminals: g.terminals.filter((t) => t.id !== terminalId)
    }))
  }

  // ── Rows ──

  moveItems(
    windowKey: string,
    itemIds: ReadonlyArray<string>,
    targetId: string | null,
    position: MovePosition
  ): LayoutSnapshot {
    const current = this.load(windowKey).layout
    const next = moveLayoutItems(current, [...itemIds], targetId, position)
    if (next === null) return this.snapshot(windowKey)
    return this.commit(windowKey, next, 'command')
  }

  /** A session enters the layout: the first row of its group or of the
   *  sidebar (`'start'`), or the last (`'end'`, a tab arriving from another
   *  window). A session the layout already holds stays where it is. */
  placeSession(
    windowKey: string,
    sessionId: string,
    groupId: string | null,
    at: 'start' | 'end' = 'start',
    cause: Cause = 'command'
  ): LayoutSnapshot {
    const current = this.load(windowKey).layout
    if (holds(current, sessionId)) return this.snapshot(windowKey)
    const group = groupId === null ? undefined : current.groups.find((g) => g.id === groupId)
    const put = (list: string[]): string[] =>
      at === 'start' ? [sessionId, ...list] : [...list, sessionId]
    const next: NormalizedLayout = group
      ? {
          groups: current.groups.map((g) =>
            g.id === group.id ? { ...g, sessionIds: put(g.sessionIds) } : g
          ),
          displayOrder: current.displayOrder
        }
      : { groups: current.groups, displayOrder: put(current.displayOrder) }
    return this.commit(windowKey, next, cause)
  }

  /** A session leaves the layout: out of the order and every group, and a
   *  terminal that ran it detached. The group stays, empty or not. */
  removeSession(windowKey: string, sessionId: string, cause: Cause = 'command'): LayoutSnapshot {
    const current = this.load(windowKey).layout
    return this.commit(
      windowKey,
      {
        groups: current.groups.map((g) => ({
          ...g,
          sessionIds: g.sessionIds.filter((sid) => sid !== sessionId),
          terminals: g.terminals.map((t) =>
            t.sessionId === sessionId ? { ...t, sessionId: null } : t
          )
        })),
        displayOrder: current.displayOrder.filter((id) => id !== sessionId)
      },
      cause
    )
  }

  absorb(windowKey: string, layout: WindowLayout, cause: Cause = 'command'): LayoutSnapshot {
    const current = this.load(windowKey).layout
    return this.commit(windowKey, absorbLayout(current, normalizeLayout(layout)), cause)
  }

  // ── Between windows ──

  /**
   * Live tabs to another window. The shell does the move (it owns the
   * processes and the windows); the layouts follow what it says moved, and
   * only that: a refused tab stays exactly where it was.
   */
  moveSessionsToWindow(
    sessionIds: ReadonlyArray<string>,
    targetWindowKey: string,
    focus: boolean
  ): Result<MoveResult, WindowNotFound | CapabilityUnavailable> {
    if (!this.host.hostsWindows) return err(noWindows())
    if (!this.host.isLive(targetWindowKey)) {
      return err(windowNotFound(targetWindowKey))
    }
    const layouts = this.list()
    const sourceOf = new Map<string, string>()
    for (const id of sessionIds) {
      const source = layouts.find((l) => holds(l, id))
      if (source) sourceOf.set(id, source.windowKey)
    }
    const outcome = this.host.rehome(sessionIds, targetWindowKey, { layout: null, focus })
    for (const id of outcome.moved) {
      const source = sourceOf.get(id)
      if (source !== undefined && source !== targetWindowKey) this.removeSession(source, id, 'move')
      this.placeSession(targetWindowKey, id, null, 'end', 'move')
    }
    return ok(outcome)
  }

  /**
   * A group whole to another window: the group object goes with the members
   * and terminals that can move; those that cannot stay in the source as
   * plain rows, never hidden (the renderer's removeGroupForMove). When the
   * group holds sessions and none can move, nothing changes anywhere.
   */
  moveGroupToWindow(
    windowKey: string,
    groupId: string,
    targetWindowKey: string
  ): Result<{ ok: boolean } & MoveResult, GroupNotFound | WindowNotFound | CapabilityUnavailable> {
    const current = this.load(windowKey).layout
    const group = current.groups.find((g) => g.id === groupId)
    if (!group) return err(groupNotFound(groupId))
    if (!this.host.hostsWindows) return err(noWindows())
    if (targetWindowKey === windowKey || !this.host.isLive(targetWindowKey)) {
      return err(windowNotFound(targetWindowKey))
    }
    const linked = linkedOf(group)
    const { movable, refused } = this.host.movable(linked, targetWindowKey)
    if (linked.length > 0 && movable.length === 0) {
      return ok({ ok: false, moved: [], refused })
    }
    const moving = new Set(movable)
    const handed: NormalizedGroup = {
      ...group,
      sessionIds: group.sessionIds.filter((sid) => moving.has(sid)),
      terminals: group.terminals.map((t) =>
        t.sessionId !== null && moving.has(t.sessionId) ? t : { ...t, sessionId: null }
      )
    }
    const stayed = linked.filter((sid) => !moving.has(sid))
    const order = current.displayOrder.filter((id) => id !== groupId)
    this.commit(
      windowKey,
      {
        groups: current.groups.filter((g) => g.id !== groupId),
        displayOrder: [...order, ...stayed.filter((sid) => !order.includes(sid))]
      },
      'move'
    )
    this.host.groupMovedAway(windowKey, groupId)
    const handedLayout: WindowLayout = { groups: [handed], displayOrder: [groupId] }
    this.absorb(targetWindowKey, handedLayout, 'move')
    const outcome = this.host.rehome(movable, targetWindowKey, {
      layout: frozen(handedLayout),
      focus: true
    })
    return ok({ ok: true, moved: outcome.moved, refused: [...outcome.refused, ...refused] })
  }

  /** The shell's close ladder: the closing window's layout handed to the
   *  primary and its document removed. Answers the layout taken, for the
   *  shell to pass in the rehome payload. */
  windowClosed(windowKey: string, primaryWindowKey: string | null): WindowLayout {
    const taken = this.load(windowKey).layout
    this.storage.remove(windowKey)
    this.cache.delete(windowKey)
    this.emit({ _tag: 'sidebar.layout_removed', windowKey })
    if (typeof primaryWindowKey === 'string' && primaryWindowKey !== windowKey) {
      this.absorb(primaryWindowKey, taken, 'window-closed')
    }
    return frozen(taken)
  }

  onChange(listener: (event: SidebarEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ── Internals ──

  private load(windowKey: string): Entry {
    let entry = this.cache.get(windowKey)
    if (!entry) {
      entry = { layout: normalizeLayout(this.storage.read(windowKey)), revision: 0 }
      this.cache.set(windowKey, entry)
    }
    return entry
  }

  /** The layouts of windows that no longer exist, folded into the primary's
   *  and their documents removed, so their groups are not lost with them. */
  private takeOrphans(windowKey: string, entry: Entry): void {
    const known = this.host.knownWindowKeys()
    let next = entry.layout
    let tookSomething = false
    for (const key of this.storage.keys()) {
      if (key === windowKey || known.has(key)) continue
      const orphan = this.cache.get(key)?.layout ?? normalizeLayout(this.storage.read(key))
      if (orphan.groups.length > 0 || orphan.displayOrder.length > 0) tookSomething = true
      next = absorbLayout(next, orphan)
      this.storage.remove(key)
      this.cache.delete(key)
    }
    if (tookSomething) this.commit(windowKey, next, 'orphans')
  }

  private editGroup(
    windowKey: string,
    groupId: string,
    edit: (group: NormalizedGroup) => NormalizedGroup
  ): Result<LayoutSnapshot, GroupNotFound> {
    const current = this.load(windowKey).layout
    if (!current.groups.some((g) => g.id === groupId)) return err(groupNotFound(groupId))
    return ok(
      this.commit(
        windowKey,
        {
          groups: current.groups.map((g) => (g.id === groupId ? edit(g) : g)),
          displayOrder: current.displayOrder
        },
        'command'
      )
    )
  }

  /** Every write: stored, counted, told. A change that changes nothing is
   *  none of the three, so an idle save never wakes the other windows. */
  private commit(windowKey: string, next: NormalizedLayout, cause: Cause): LayoutSnapshot {
    const entry = this.load(windowKey)
    if (JSON.stringify(next) === JSON.stringify(entry.layout)) return this.snapshot(windowKey)
    const layout = structuredClone(next)
    this.storage.write(windowKey, layout)
    this.cache.set(windowKey, { layout, revision: entry.revision + 1 })
    const snapshot = this.snapshot(windowKey)
    this.emit({ _tag: 'sidebar.layout_changed', layout: snapshot, cause })
    return snapshot
  }

  private snapshot(windowKey: string): LayoutSnapshot {
    const entry = this.load(windowKey)
    return frozen({ windowKey, revision: entry.revision, ...entry.layout })
  }

  private emit(event: SidebarEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[clave-server] sidebar listener failed', error)
      }
    }
  }
}
