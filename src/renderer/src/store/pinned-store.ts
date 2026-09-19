import { create } from 'zustand'
import { substituteTokens } from './prompt-tokens'
import type { PinnedGroup, PinnedGroupSession, PinnedGroupTerminal, GroupTerminalColor, GroupTerminalConfig } from './session-types'
import { resolveGroupDefaults } from './group-defaults'
import { resolveDeclaredGroupView } from '../../../shared/group-view'
import { useSessionStore } from './session-store'
import { getActiveWorkspaceId } from './workspace-store'
import { assertPinnableSessions } from '../lib/conversation-pin-guard'

function assertPinnableGroup(groupId: string | null): void {
  if (!groupId) return
  const { groups, sessions } = useSessionStore.getState()
  const group = groups.find((candidate) => candidate.id === groupId)
  if (group) assertPinnableSessions(sessions.filter((session) => group.sessionIds.includes(session.id)))
}

export type { PinnedGroup }

type PinnedState = 'idle' | 'active-visible' | 'active-hidden'

export function getPinnedState(pg: PinnedGroup): PinnedState {
  if (!pg.activeGroupId) return 'idle'
  return pg.visible ? 'active-visible' : 'active-hidden'
}

export interface PinnedGroupBlueprint {
  id: string
  name: string
  cwd: string | null
  color: GroupTerminalColor | null
  prompt?: string | null
  sessions: PinnedGroupSession[]
  terminals: PinnedGroupTerminal[]
  createdAt: number
  filePath?: string | null
  rootDir?: string | null
  workspaceRoot?: string | null
  groupIndex?: number
  toolbar?: boolean
  logo?: string | null
  category?: string | null
  discoveredBy?: string | null
  workspaceId?: string | null
}

/** Blueprint snapshot of the current pins — what gets persisted into
 *  workspace-state.json (runtime activeGroupId/visible deliberately excluded,
 *  exactly like the retired localStorage serialization). */
export { substituteTokens } from './prompt-tokens'

export function serializePinnedGroups(groups: PinnedGroup[]): PinnedGroupBlueprint[] {
  return groups.map(({ id, name, cwd, color, prompt, sessions, terminals, createdAt, filePath, rootDir, workspaceRoot, groupIndex, toolbar, logo, category, discoveredBy, workspaceId }) => ({
    id, name, cwd, color, prompt, sessions, terminals, createdAt, filePath, rootDir, workspaceRoot, groupIndex, toolbar, logo, category, discoveredBy, workspaceId
  }))
}

/** A pin id names ONE pin. The state file is written partition by partition
 *  (one per workspace id), so the same id can end up in two partitions when a
 *  pin is re-stamped between writes; whichever copy comes first wins here, so
 *  a file that already carries duplicates hydrates clean and is rewritten
 *  clean on the next persist. */
export function dedupePinsById<T extends { id: string }>(pins: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const pin of pins) {
    if (seen.has(pin.id)) continue
    seen.add(pin.id)
    out.push(pin)
  }
  return out
}

/** Hydrate pins from persisted blueprints (workspace:load at boot). Replaces
 *  the retired localStorage read; runtime state starts reset, as always. */
export function hydratePinnedGroups(blueprints: PinnedGroupBlueprint[]): void {
  const groups: PinnedGroup[] = dedupePinsById(blueprints).map((bp) => ({
    ...bp,
    // Back-compat: blueprints persisted before the Antigravity switch key their
    // sessions by the retired `geminiMode`. Map it forward so the pin still
    // launches the right provider (now agy) after an upgrade.
    sessions: bp.sessions.map((s) => ({
      ...s,
      antigravityMode: s.antigravityMode ?? (s as { geminiMode?: boolean }).geminiMode ?? false
    })),
    activeGroupId: null,
    visible: false
  }))
  usePinnedStore.setState({ pinnedGroups: groups })
}

interface PinnedStoreState {
  pinnedGroups: PinnedGroup[]
  pinnedCollapsed: boolean
  addPinnedGroup: (pg: PinnedGroup) => void
  removePinnedGroup: (id: string) => void
  renamePinnedGroup: (id: string, name: string) => void
  togglePinnedCollapsed: () => void
  setActiveGroupId: (pinnedId: string, groupId: string | null) => void
  setVisible: (pinnedId: string, visible: boolean) => void
  updatePinnedGroup: (pinnedId: string, updates: Partial<PinnedGroup>) => void
}

export const usePinnedStore = create<PinnedStoreState>((set) => ({
  pinnedGroups: [],
  pinnedCollapsed: localStorage.getItem('clave-pinned-collapsed') === 'true',

  addPinnedGroup: (pg) =>
    set((s) => {
      return { pinnedGroups: [...s.pinnedGroups, pg] }
    }),

  removePinnedGroup: (id) =>
    set((s) => {
      const removed = s.pinnedGroups.find((pg) => pg.id === id)
      const next = s.pinnedGroups.filter((pg) => pg.id !== id)
      // Multi-group files share one watcher — only unwatch with the last pin
      if (removed?.filePath && !next.some((pg) => pg.filePath === removed.filePath)) {
        window.electronAPI?.unwatchClaveFile(removed.filePath).catch(() => {})
      }
      return { pinnedGroups: next }
    }),

  renamePinnedGroup: (id, name) =>
    set((s) => {
      const next = s.pinnedGroups.map((pg) => (pg.id === id ? { ...pg, name } : pg))
      const renamed = next.find((pg) => pg.id === id)
      if (renamed) syncToClaveFile(renamed)
      return { pinnedGroups: next }
    }),

  togglePinnedCollapsed: () =>
    set((s) => {
      const next = !s.pinnedCollapsed
      localStorage.setItem('clave-pinned-collapsed', String(next))
      return { pinnedCollapsed: next }
    }),

  setActiveGroupId: (pinnedId, groupId) =>
    set((s) => ({
      pinnedGroups: s.pinnedGroups.map((pg) =>
        pg.id === pinnedId ? { ...pg, activeGroupId: groupId } : pg
      )
    })),

  setVisible: (pinnedId, visible) =>
    set((s) => ({
      pinnedGroups: s.pinnedGroups.map((pg) =>
        pg.id === pinnedId ? { ...pg, visible } : pg
      )
    })),

  updatePinnedGroup: (pinnedId, updates) =>
    set((s) => {
      const next = s.pinnedGroups.map((pg) =>
        pg.id === pinnedId ? { ...pg, ...updates } : pg
      )
      return { pinnedGroups: next }
    })
}))

// ── Sync to .clave file (debounced) ──

let syncTimer: ReturnType<typeof setTimeout> | null = null
const pendingSyncs = new Set<string>()

function syncToClaveFile(pg: PinnedGroup): void {
  if (!pg.filePath) return
  // Track by filePath (not pin ID) so multi-group files are written once
  pendingSyncs.add(pg.filePath)

  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    const store = usePinnedStore.getState()
    // Deduplicate by filePath
    for (const fp of pendingSyncs) {
      const pinsForFile = store.pinnedGroups
        .filter((p) => p.filePath === fp)
        .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0))
      if (pinsForFile.length === 0) continue

      const isMulti = pinsForFile.length > 1 || pinsForFile[0].groupIndex !== undefined

      const serializePin = (p: PinnedGroup) => ({
        name: p.name,
        cwd: p.cwd,
        color: p.color,
        ...(p.toolbar ? { toolbar: true } : {}),
        ...(p.logo ? { logo: p.logo } : {}),
        ...(p.prompt ? { prompt: p.prompt } : {}),
        ...(p.view ? { view: p.view } : {}),
        sessions: p.sessions.map((s) => ({ cwd: s.cwd, name: s.name, claudeMode: s.claudeMode, antigravityMode: s.antigravityMode, codexMode: s.codexMode, piMode: s.piMode, claudeAgentsMode: s.claudeAgentsMode, dangerousMode: s.dangerousMode, ...(s.prompt ? { prompt: s.prompt } : {}), ...(s.rootSession ? { rootSession: true } : {}) })),
        terminals: p.terminals.map((t) => ({ command: t.command, commandMode: t.commandMode, color: t.color, icon: t.icon, cwd: t.cwd, autoLaunchLocalhost: t.autoLaunchLocalhost, persistent: t.persistent, serverUrl: t.serverUrl, groupView: t.groupView })),
        ...(p.category ? { category: p.category } : {})
      })

      const writeData = isMulti
        ? { groups: pinsForFile.map(serializePin) }
        : serializePin(pinsForFile[0])

      // Use rootDir from the first pin for this file (all pins from same file share rootDir)
      const rootDirForFile = pinsForFile[0].rootDir ?? undefined
      window.electronAPI?.writeClaveFile(fp, writeData, rootDirForFile)
        .catch((err) => console.error('[clave] Failed to write .clave file:', err))
    }
    pendingSyncs.clear()
    syncTimer = null
  }, 300)
}

// ── Import / Export ──

function createPinnedFromGroup(
  g: { name: string; cwd: string; color: string | null; toolbar?: boolean; category?: string; logo?: string; prompt?: string; view?: string; sessions: { cwd: string; name: string; claudeMode: boolean; antigravityMode: boolean; codexMode: boolean; piMode?: boolean; claudeAgentsMode?: boolean; dangerousMode: boolean; prompt?: string; rootSession?: boolean }[]; terminals: { command: string; commandMode: 'prefill' | 'auto'; color: string; icon?: string; cwd?: string; autoLaunchLocalhost?: boolean; persistent?: boolean; serverUrl?: string; groupView?: boolean }[] },
  filePath: string,
  groupIndex?: number,
  rootDir?: string | null,
  discoveredBy?: string | null,
  workspaceRoot?: string | null,
  workspaceId?: string | null
): PinnedGroup {
  return {
    id: crypto.randomUUID(),
    name: g.name,
    cwd: g.cwd,
    color: (g.color as GroupTerminalColor) ?? null,
    prompt: g.prompt ?? null,
    view: g.view ?? null,
    sessions: g.sessions,
    terminals: groupDataToPinnedTerminals(g.terminals),
    createdAt: Date.now(),
    filePath,
    rootDir: rootDir ?? null,
    workspaceRoot: workspaceRoot ?? null,
    groupIndex,
    toolbar: g.toolbar,
    logo: g.logo,
    category: g.category ?? null,
    discoveredBy: discoveredBy ?? null,
    workspaceId: workspaceId ?? null,
    activeGroupId: null,
    visible: false
  }
}

function groupDataToPinnedTerminals(terminals: { command: string; commandMode: 'prefill' | 'auto'; color: string; icon?: string; cwd?: string; autoLaunchLocalhost?: boolean; persistent?: boolean; serverUrl?: string; groupView?: boolean }[]): PinnedGroupTerminal[] {
  return terminals.map((t) => ({
    command: t.command,
    commandMode: t.commandMode,
    color: t.color as GroupTerminalColor,
    icon: t.icon as PinnedGroupTerminal['icon'],
    cwd: t.cwd,
    autoLaunchLocalhost: t.autoLaunchLocalhost,
    persistent: t.persistent,
    serverUrl: t.serverUrl,
    groupView: t.groupView
  }))
}

/** Import a .clave file as pinned group(s) and optionally auto-launch.
 *  Returns info about the first pin, and whether it already existed. */
export async function importClaveFile(filePath: string, options?: { autoLaunch?: boolean; rootDir?: string; discoveredBy?: string; workspaceRoot?: string; workspaceId?: string | null }): Promise<{ pinnedId: string; alreadyExists: boolean } | null> {
  const rootDir = options?.rootDir
  const discoveredBy = options?.discoveredBy
  const workspaceRoot = options?.workspaceRoot
  const workspaceId = options?.workspaceId
  const result = await window.electronAPI?.readClaveFile(filePath, rootDir)
  if (!result) return null

  const autoLaunch = options?.autoLaunch ?? true

  // Normalize to array of groups
  const groups = result.type === 'multi'
    ? result.groups
    : [{ name: result.name, cwd: result.cwd, color: result.color, toolbar: result.toolbar, category: result.category, logo: result.logo, prompt: result.prompt, sessions: result.sessions, terminals: result.terminals }]

  // Check if already imported — reuse existing pins
  const existingPins = usePinnedStore.getState().pinnedGroups.filter((pg) => pg.filePath === filePath)
  if (existingPins.length > 0) {
    // Update existing pins from the file
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      const existing = existingPins.find((p) => p.groupIndex === i) ?? existingPins[i]
      if (existing) {
        usePinnedStore.getState().updatePinnedGroup(existing.id, {
          name: g.name,
          cwd: g.cwd,
          color: (g.color as GroupTerminalColor) ?? null,
          prompt: g.prompt ?? null,
          sessions: g.sessions,
          terminals: groupDataToPinnedTerminals(g.terminals),
          groupIndex: result.type === 'multi' ? i : undefined,
          toolbar: g.toolbar,
          logo: g.logo,
          category: g.category ?? null,
          // Re-stamp resolution context on boot re-import (repairs pins persisted
          // before these fields existed, so sync-back re-relativizes correctly).
          ...(rootDir !== undefined ? { rootDir } : {}),
          ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
          ...(discoveredBy !== undefined ? { discoveredBy } : {}),
          ...(workspaceId !== undefined ? { workspaceId } : {})
        })
        if (autoLaunch) {
          const state = getPinnedState(existing)
          if (state === 'idle' || state === 'active-hidden') {
            await togglePinnedGroup(existing.id)
          }
        }
      }
    }
    // Add any new groups that weren't in existing pins
    for (let i = existingPins.length; i < groups.length; i++) {
      const g = groups[i]
      const pinned = createPinnedFromGroup(g, filePath, result.type === 'multi' ? i : undefined, rootDir, discoveredBy, workspaceRoot, workspaceId)
      usePinnedStore.getState().addPinnedGroup(pinned)
      if (autoLaunch) await togglePinnedGroup(pinned.id)
    }
    return { pinnedId: existingPins[0].id, alreadyExists: true }
  }

  // Fresh import
  window.electronAPI?.watchClaveFile(filePath).catch(() => {})

  let firstId: string | null = null
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const pinned = createPinnedFromGroup(g, filePath, result.type === 'multi' ? i : undefined, rootDir, discoveredBy, workspaceRoot, workspaceId)
    usePinnedStore.getState().addPinnedGroup(pinned)
    if (!firstId) firstId = pinned.id
    if (autoLaunch) await togglePinnedGroup(pinned.id)
  }

  return firstId ? { pinnedId: firstId, alreadyExists: false } : null
}

/** Sync one workspace's pins from its profile file + auto-discovery. Replaces
 *  the retired activation import/remove dance: pins are upserted stamped with
 *  the workspace id, and pins of this workspace whose backing file vanished
 *  from the profile/discovery set are pruned. Ad-hoc pins (no filePath) are
 *  never touched. Called on boot (active workspace), activation, profile
 *  change, and workspace registration — never on plain view switches away. */
export async function refreshWorkspacePins(ws: { id: string; rootDir: string; profileFile: string | null }): Promise<void> {
  const keep = new Set<string>()

  if (ws.profileFile) {
    const exists = await window.electronAPI?.claveFileExists(ws.profileFile)
    if (exists) {
      keep.add(ws.profileFile)
      await importClaveFile(ws.profileFile, {
        autoLaunch: false,
        rootDir: ws.rootDir,
        workspaceRoot: ws.rootDir,
        workspaceId: ws.id
      })

      // Auto-discover repo .clave files when the profile enables it. The
      // discovery workspaceId hint prefers a same-named profile inside each
      // repo (romain.clave over default.clave for the "romain" profile).
      const adConfig = await window.electronAPI?.readAutoDiscoverConfig(ws.profileFile)
      if (adConfig?.enabled) {
        const profileName = ws.profileFile.split(/[\\/]/).pop()?.replace('.clave', '')
        const discovered = await window.electronAPI?.discoverClaveFilesRecursive(ws.rootDir, {
          ...adConfig,
          workspaceId: profileName && profileName !== 'default' ? profileName : undefined
        })
        for (const file of discovered ?? []) {
          if (file.path === ws.profileFile) continue
          keep.add(file.path)
          await importClaveFile(file.path, {
            autoLaunch: false,
            rootDir: file.rootDir,
            discoveredBy: ws.profileFile,
            workspaceRoot: ws.rootDir,
            workspaceId: ws.id
          })
        }
      }
    }
    // Profile file missing → keep persisted pins as-is (stale but functional);
    // Settings surfaces the warning. Pruning here would punish a transient
    // unmount (network volume, git checkout) by wiping the workspace.
    else return
  }

  // Prune file-backed pins of this workspace whose file left the set (profile
  // switched, repo deleted, group removed from the file). null profile prunes
  // everything file-backed — a bare workspace has no file-defined pins.
  const stale = usePinnedStore
    .getState()
    .pinnedGroups.filter((pg) => pg.workspaceId === ws.id && pg.filePath && !keep.has(pg.filePath))
  for (const pg of stale) {
    usePinnedStore.getState().removePinnedGroup(pg.id)
  }
}

/** Get the default file name for a pinned group export */
export function getExportFileName(pinnedId: string): string {
  const pg = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pinnedId)
  if (!pg) return 'group.clave'
  return `${pg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.clave`
}

/** Export a pinned group to a .clave file at the specified path */
export async function exportClaveFile(pinnedId: string, folder: string, fileName: string, keepSynced: boolean): Promise<void> {
  const pg = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pinnedId)
  if (!pg) return
  assertPinnableGroup(pg.activeGroupId)

  const filePath = `${folder}/${fileName}`

  await window.electronAPI?.writeClaveFile(filePath, {
    name: pg.name,
    cwd: pg.cwd,
    color: pg.color,
    ...(pg.prompt ? { prompt: pg.prompt } : {}),
    ...(pg.view ? { view: pg.view } : {}),
    sessions: pg.sessions.map((s) => ({
      cwd: s.cwd,
      name: s.name,
      claudeMode: s.claudeMode,
      antigravityMode: s.antigravityMode,
      codexMode: s.codexMode,
      piMode: s.piMode,
      claudeAgentsMode: s.claudeAgentsMode,
      dangerousMode: s.dangerousMode
    })),
    terminals: pg.terminals.map((t) => ({
      command: t.command,
      commandMode: t.commandMode,
      color: t.color,
      icon: t.icon,
      cwd: t.cwd,
      persistent: t.persistent,
      serverUrl: t.serverUrl,
      groupView: t.groupView
    })),
    ...(pg.category ? { category: pg.category } : {})
  })

  if (keepSynced) {
    usePinnedStore.getState().updatePinnedGroup(pinnedId, { filePath })
    window.electronAPI?.watchClaveFile(filePath).catch(() => {})
  }
}

// ── File watch handler ──

/** Initialize file watchers for all file-backed pins and set up the listener */
export function initClaveFileWatchers(): () => void {
  // Start watching all file-backed pins
  const pins = usePinnedStore.getState().pinnedGroups
  for (const pg of pins) {
    if (pg.filePath) {
      window.electronAPI?.watchClaveFile(pg.filePath).catch(() => {})
    }
  }

  // Listen for file change events
  const cleanup = window.electronAPI?.onClaveFileChanged(async (filePath: string) => {
    const pinsForFile = usePinnedStore
      .getState()
      .pinnedGroups.filter((p) => p.filePath === filePath)
      .sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0))
    if (pinsForFile.length === 0) return

    // Use rootDir from the first pin for this file
    const firstPin = pinsForFile[0]
    const rootDirForFile = firstPin.rootDir ?? undefined
    const result = await window.electronAPI?.readClaveFile(filePath, rootDirForFile)
    if (!result) return

    // Normalize to array of groups
    const groups = result.type === 'multi'
      ? result.groups
      : [{ name: result.name, cwd: result.cwd, color: result.color, toolbar: result.toolbar, category: result.category, logo: result.logo, prompt: result.prompt, sessions: result.sessions, terminals: result.terminals }]

    for (let i = 0; i < pinsForFile.length && i < groups.length; i++) {
      const pg = pinsForFile.find((p) => p.groupIndex === i) ?? pinsForFile[i]
      const g = groups[i]
      if (!pg || !g) continue

      const state = getPinnedState(pg)
      const groupIndex = result.type === 'multi' ? i : undefined

      if (state === 'idle') {
        usePinnedStore.getState().updatePinnedGroup(pg.id, {
          name: g.name,
          cwd: g.cwd,
          color: (g.color as GroupTerminalColor) ?? null,
          toolbar: g.toolbar,
          logo: g.logo,
          category: g.category ?? null,
          // The group's default prompt reloads with the file like every other
          // field. Without this the watcher parses the edited prompt and throws
          // it away, so the group's `+` keeps dispatching agents on the brief
          // the user thinks they just changed — wrong instructions, silently.
          prompt: g.prompt ?? null,
          sessions: g.sessions,
          terminals: groupDataToPinnedTerminals(g.terminals),
          groupIndex
        })
      } else {
        // Active — only cosmetic updates, never touch running sessions. The
        // prompt is safe to refresh: it is read at the next `+` press, never
        // applied to a session that is already running.
        usePinnedStore.getState().updatePinnedGroup(pg.id, {
          name: g.name,
          color: (g.color as GroupTerminalColor) ?? null,
          toolbar: g.toolbar,
          logo: g.logo,
          category: g.category ?? null,
          prompt: g.prompt ?? null,
          terminals: groupDataToPinnedTerminals(g.terminals),
          groupIndex
        })

        if (pg.activeGroupId) {
          const sessionState = useSessionStore.getState()
          const group = sessionState.groups.find((gr) => gr.id === pg.activeGroupId)
          if (group) {
            if (group.name !== g.name) {
              useSessionStore.getState().renameGroup(pg.activeGroupId, g.name)
            }
            const newColor = (g.color as GroupTerminalColor) ?? null
            if ((group.color ?? null) !== newColor) {
              useSessionStore.getState().setGroupColor(pg.activeGroupId, newColor)
            }
          }
        }
      }
    }

    // Groups added to the file → new pins (never auto-launched). The new pin
    // inherits the file's workspace stamp: an unstamped pin lands in the null
    // partition of the state file, gets re-stamped on the next boot refresh,
    // and the stale null copy is then re-hydrated beside it — one more copy
    // of the group per boot.
    for (let i = pinsForFile.length; i < groups.length; i++) {
      const g = groups[i]
      const pinned = createPinnedFromGroup(g, filePath, result.type === 'multi' ? i : undefined, firstPin.rootDir, firstPin.discoveredBy, firstPin.workspaceRoot, firstPin.workspaceId)
      usePinnedStore.getState().addPinnedGroup(pinned)
    }

    // Groups removed from the file → drop their pins (sessions are never killed)
    for (let i = groups.length; i < pinsForFile.length; i++) {
      const pg = pinsForFile.find((p) => p.groupIndex === i) ?? pinsForFile[i]
      if (pg) usePinnedStore.getState().removePinnedGroup(pg.id)
    }
  })

  return cleanup ?? (() => {})
}

// ── Original functions (unchanged) ──

/** Capture a live group as a pinned blueprint */
export function pinGroupFromCurrent(groupId: string): void {
  assertPinnableGroup(groupId)
  const { groups, sessions } = useSessionStore.getState()
  const group = groups.find((g) => g.id === groupId)
  if (!group) return

  // Exclude sessions that are linked to a group terminal — those are restored via terminal configs
  const terminalSessionIds = new Set(
    group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
  )

  const groupSessions: PinnedGroupSession[] = group.sessionIds
    .filter((sid) => !terminalSessionIds.has(sid))
    .map((sid) => sessions.find((s) => s.id === sid))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => ({
      cwd: s.cwd,
      name: s.name,
      claudeMode: s.claudeMode,
      antigravityMode: s.antigravityMode,
      codexMode: s.codexMode,
      piMode: s.piMode,
      claudeAgentsMode: s.claudeAgentsMode,
      dangerousMode: s.dangerousMode,
      // A root-anchored group keeps its anchor through the pin. The session is
      // recorded at its absolute cwd (already the root, so the respawn lands
      // there either way); the flag is what tells the `+` of the group this pin
      // stamps out later to land there too, instead of in the group's cwd.
      ...(group.rootSession ? { rootSession: true } : {})
    }))

  const groupTerminals: PinnedGroupTerminal[] = group.terminals.map((t) => ({
    command: t.command,
    commandMode: t.commandMode,
    color: t.color,
    icon: t.icon,
    serverUrl: t.serverUrl
  }))

  const pinned: PinnedGroup = {
    id: crypto.randomUUID(),
    name: group.name,
    cwd: group.cwd,
    color: group.color ?? null,
    // Round-trips the group's default prompt the same way createPinnedFromGroup
    // does. Without it the trip is one-way: .clave → pin → group keeps the
    // prompt, group → pin → .clave silently loses it.
    prompt: group.prompt ?? null,
    sessions: groupSessions,
    terminals: groupTerminals,
    createdAt: Date.now(),
    // Link to the live group immediately — clicking won't respawn
    activeGroupId: groupId,
    visible: true
  }

  usePinnedStore.getState().addPinnedGroup(pinned)
}

/** Spawn a fresh group from a template, every time, without linking the pin to
 *  the live group. A template is a stamp: clicking it produces a group and is
 *  done. Use this (not togglePinnedGroup) for the template picker popup. */
export async function spawnTemplate(pinnedId: string): Promise<void> {
  const pg = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pinnedId)
  if (!pg) return
  await spawnPinnedGroup(pinnedId, pg, { link: false })
}

/** Toggle a pinned group: idle → spawn, active+visible → hide, active+hidden → show */
export async function togglePinnedGroup(pinnedId: string): Promise<void> {
  const pg = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pinnedId)
  if (!pg) return

  const state = getPinnedState(pg)

  // Active + Visible → always hide (don't check alive — user wants to toggle off)
  if (state === 'active-visible') {
    hidePinnedGroup(pinnedId)
    return
  }

  // For idle or active+hidden: validate linked group still exists
  if (pg.activeGroupId) {
    const sessionState = useSessionStore.getState()
    const linkedGroup = sessionState.groups.find((g) => g.id === pg.activeGroupId)
    if (!linkedGroup) {
      // Group was deleted externally — reset to idle and spawn fresh
      usePinnedStore.getState().setActiveGroupId(pinnedId, null)
      usePinnedStore.getState().setVisible(pinnedId, false)
      await spawnPinnedGroup(pinnedId, pg)
      return
    }

    // Active + Hidden → show the existing group
    showPinnedGroup(pinnedId, pg)
    return
  }

  // Idle → spawn fresh
  await spawnPinnedGroup(pinnedId, pg)
}

async function spawnPinnedGroup(
  pinnedId: string,
  pg: PinnedGroup,
  options?: { link?: boolean }
): Promise<void> {
  if (!window.electronAPI?.spawnSession) return
  const link = options?.link ?? true

  const spawnedIds: string[] = []

  for (const session of pg.sessions) {
    try {
      const pinOtherProvider = session.antigravityMode || session.codexMode || session.piMode || session.claudeAgentsMode
      // rootSession: spawn at the workspace root instead of the session's cwd
      // (which stays the project dir). No-op if the pin has no workspaceRoot.
      const atRoot = session.rootSession === true && !!pg.workspaceRoot
      const spawnCwd = atRoot ? pg.workspaceRoot! : session.cwd
      // `claude agents` is spawned bare and rejects a positional prompt, so never
      // hand it one — matches pty-manager's agents branch. Path tokens in the
      // prompt are substituted here (project dir = session.cwd, root = workspaceRoot).
      const initialPrompt = session.claudeAgentsMode
        ? undefined
        : session.prompt
          ? substituteTokens(session.prompt, pg.workspaceRoot ?? pg.rootDir ?? null, session.cwd)
          : undefined
      const sessionInfo = await window.electronAPI.spawnSession(spawnCwd, {
        claudeMode: pinOtherProvider ? false : session.claudeMode,
        antigravityMode: session.antigravityMode,
        codexMode: session.codexMode,
        piMode: session.piMode,
        claudeAgentsMode: session.claudeAgentsMode,
        dangerousMode: session.dangerousMode,
        initialPrompt,
        // The pin's workspace wins over the active one — an MCP launch of a
        // hidden workspace's pin must not leak its sessions into the active view.
        workspaceId: pg.workspaceId ?? undefined
      })

      useSessionStore.getState().addSession({
        id: sessionInfo.id,
        cwd: sessionInfo.cwd,
        folderName: sessionInfo.folderName,
        name: session.name,
        alive: sessionInfo.alive,
        activityStatus: 'idle',
        promptWaiting: null,
        claudeMode: pinOtherProvider ? false : session.claudeMode,
        antigravityMode: session.antigravityMode,
        codexMode: session.codexMode,
        piMode: session.piMode,
        claudeAgentsMode: session.claudeAgentsMode,
        dangerousMode: session.dangerousMode,
        model: sessionInfo.model,
        claudeSessionId: sessionInfo.claudeSessionId,
        piSessionId: sessionInfo.piSessionId,
        launchProfileId: sessionInfo.launchProfileId,
        piProvider: sessionInfo.piProvider,
        piThinking: sessionInfo.piThinking,
        // Persist so Duplicate can re-prime the clone (see Sidebar duplicate).
        initialPrompt,
        sessionType: 'local',
        detectedUrl: null,
        hasUnseenActivity: false,
        workspaceId: pg.workspaceId ?? undefined
      })

      if (session.name !== sessionInfo.folderName) {
        useSessionStore.getState().renameSession(sessionInfo.id, session.name)
      }

      spawnedIds.push(sessionInfo.id)
    } catch (err) {
      console.error(`[pinned] Failed to spawn session "${session.name}":`, err)
    }
  }

  if (spawnedIds.length === 0) {
    console.warn('[pinned] No sessions could be spawned')
    return
  }

  // Create group — stamped with the pin's workspace, not the active one.
  useSessionStore.getState().createGroup(spawnedIds, pg.name, pg.workspaceId ?? undefined)

  const sessionState = useSessionStore.getState()
  const newGroup = sessionState.groups[sessionState.groups.length - 1]
  if (!newGroup) return

  // Terminals are materialized before the patch so the `groupView` binding below
  // can name the terminal that serves the page (its start action when down).
  const liveTerminals: GroupTerminalConfig[] = pg.terminals.map((t) => ({
    id: crypto.randomUUID(),
    command: t.command,
    commandMode: t.commandMode,
    color: t.color as GroupTerminalColor,
    icon: t.icon,
    cwd: t.cwd,
    autoLaunchLocalhost: t.autoLaunchLocalhost,
    serverUrl: t.serverUrl,
    groupView: t.groupView,
    sessionId: null
  }))
  // What the user sees on clicking the group: a terminal's served page
  // (`groupView`) or the group's own `view`, a page needing no process at all.
  // resolveDeclaredGroupView owns the precedence and both inert cases.
  const declaredView = resolveDeclaredGroupView(liveTerminals, pg.view, pg.name)

  // Patch group with saved metadata
  const defaults = resolveGroupDefaults(pg)
  useSessionStore.setState((s) => ({
    groups: s.groups.map((g) =>
      g.id === newGroup.id
        ? {
            ...g,
            cwd: pg.cwd ?? g.cwd,
            color: pg.color,
            // The group's default prompt travels with it, and so does where
            // its sessions open: sessions launched later from the live group's
            // `+` inherit what the .clave declared — at group level, or (what
            // every real file does) on the group's first session, root-anchored
            // or not. See resolveGroupDefaults.
            prompt: defaults.prompt,
            rootSession: defaults.rootSession,
            terminals: liveTerminals,
            ...(declaredView ? { view: declaredView } : {})
          }
        : g
    )
  }))

  // Link pinned group to the live group — skipped for pure-stamp spawns
  // (template popup), so the pin never holds a reference to a live group and
  // can't be stranded when that group's sessions are later deleted.
  if (link) {
    usePinnedStore.getState().setActiveGroupId(pinnedId, newGroup.id)
    usePinnedStore.getState().setVisible(pinnedId, true)
  }

  // Focus the first session — unless the pin belongs to a hidden workspace
  // (MCP launch): the spawned group must not steal the user's visible focus.
  const activeWorkspaceId = getActiveWorkspaceId()
  const pinVisible = pg.workspaceId == null || activeWorkspaceId == null || pg.workspaceId === activeWorkspaceId
  if (spawnedIds.length > 0 && pinVisible) {
    useSessionStore.getState().setFocusedSession(spawnedIds[0])
    useSessionStore.getState().selectSession(spawnedIds[0], false)
  }
}

function hidePinnedGroup(pinnedId: string): void {
  usePinnedStore.getState().setVisible(pinnedId, false)
}

function showPinnedGroup(pinnedId: string, pg: PinnedGroup): void {
  usePinnedStore.getState().setVisible(pinnedId, true)

  // Focus the first session in the group
  if (!pg.activeGroupId) return
  const group = useSessionStore.getState().groups.find((g) => g.id === pg.activeGroupId)
  if (group && group.sessionIds.length > 0) {
    useSessionStore.getState().setFocusedSession(group.sessionIds[0])
    useSessionStore.getState().selectSession(group.sessionIds[0], false)
  }
}

/** Reveal a live group that a pinned toggle is currently hiding. No-op when
 *  nothing is hiding it. The group switcher calls this before filtering to a
 *  group: picking a group has to produce that group, and the toolbar's pinned
 *  toggle would otherwise leave the list empty with no hint as to why. */
export function revealGroup(groupId: string): void {
  const pinned = usePinnedStore
    .getState()
    .pinnedGroups.find((pg) => pg.activeGroupId === groupId && !pg.visible)
  if (pinned) usePinnedStore.getState().setVisible(pinned.id, true)
}

/** Returns the set of group IDs that are hidden by pinned toggle (active but not visible) */
export function getHiddenGroupIds(): Set<string> {
  const ids = new Set<string>()
  for (const pg of usePinnedStore.getState().pinnedGroups) {
    if (pg.activeGroupId && !pg.visible) {
      ids.add(pg.activeGroupId)
    }
  }
  return ids
}

/** Remove a pinned group — only removes the pin, never kills running sessions */
export function removePinnedGroupWithCleanup(pinnedId: string): void {
  usePinnedStore.getState().removePinnedGroup(pinnedId)
}

/** Re-sync a pinned group's blueprint from the current live group state */
export function resyncPinnedGroup(groupId: string): void {
  assertPinnableGroup(groupId)
  const { groups, sessions } = useSessionStore.getState()
  const group = groups.find((g) => g.id === groupId)
  if (!group) return

  const pinnedGroups = usePinnedStore.getState().pinnedGroups
  const pg = pinnedGroups.find((p) => p.activeGroupId === groupId)
  if (!pg) return

  const terminalSessionIds = new Set(
    group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
  )

  const updatedSessions: PinnedGroupSession[] = group.sessionIds
    .filter((sid) => !terminalSessionIds.has(sid))
    .map((sid) => sessions.find((s) => s.id === sid))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => ({
      cwd: s.cwd,
      name: s.name,
      claudeMode: s.claudeMode,
      antigravityMode: s.antigravityMode,
      codexMode: s.codexMode,
      piMode: s.piMode,
      claudeAgentsMode: s.claudeAgentsMode,
      dangerousMode: s.dangerousMode
    }))

  // Carry every live-config field; `persistent` lives only on the pin (not on
  // the live GroupTerminalConfig), so preserve it from the prior blueprint by
  // index — dropping fields here would corrupt the backing .clave on sync.
  const updatedTerminals: PinnedGroupTerminal[] = group.terminals.map((t, i) => ({
    command: t.command,
    commandMode: t.commandMode,
    color: t.color,
    icon: t.icon,
    cwd: t.cwd,
    autoLaunchLocalhost: t.autoLaunchLocalhost,
    serverUrl: t.serverUrl,
    groupView: t.groupView,
    persistent: pg.terminals[i]?.persistent
  }))

  // A view bound to a terminal is already expressed by that terminal's
  // `groupView`; writing it here too would declare the same page twice. Only a
  // free-standing view (a file, or a URL nothing in the group serves) belongs in
  // the group's own `view` key.
  const liveView = group.view && !group.view.terminalId ? group.view.url : null

  usePinnedStore.setState((s) => {
    const next = s.pinnedGroups.map((p) =>
      p.id === pg.id
        ? {
            ...p,
            name: group.name,
            cwd: group.cwd,
            color: group.color ?? null,
            view: liveView,
            sessions: updatedSessions,
            terminals: updatedTerminals
          }
        : p
    )
    // Sync to .clave file if backed
    const updated = next.find((p) => p.id === pg.id)
    if (updated) syncToClaveFile(updated)
    return { pinnedGroups: next }
  })
}

/** Find the pinned group linked to a live group (if any) */
export function findPinnedByGroupId(groupId: string): PinnedGroup | undefined {
  return usePinnedStore.getState().pinnedGroups.find((p) => p.activeGroupId === groupId)
}

/** Check if a pinned group's blueprint is out of sync with the live group */
export function isPinnedOutOfSync(groupId: string): boolean {
  const pg = findPinnedByGroupId(groupId)
  if (!pg) return false

  const { groups, sessions } = useSessionStore.getState()
  const group = groups.find((g) => g.id === groupId)
  if (!group) return false

  // Compare session count (excluding terminal-linked sessions)
  const terminalSessionIds = new Set(
    group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
  )
  const liveSessions = group.sessionIds.filter((sid) => !terminalSessionIds.has(sid))
  if (liveSessions.length !== pg.sessions.length) return true

  // Compare session configs
  for (let i = 0; i < liveSessions.length; i++) {
    const s = sessions.find((sess) => sess.id === liveSessions[i])
    const ps = pg.sessions[i]
    if (!s || !ps) return true
    if (s.cwd !== ps.cwd || s.claudeMode !== ps.claudeMode || s.antigravityMode !== ps.antigravityMode || s.codexMode !== ps.codexMode || (!!s.piMode) !== (!!ps.piMode) || (!!s.claudeAgentsMode) !== (!!ps.claudeAgentsMode) || s.dangerousMode !== ps.dangerousMode) return true
  }

  // Compare terminal count and configs
  if (group.terminals.length !== pg.terminals.length) return true
  for (let i = 0; i < group.terminals.length; i++) {
    const t = group.terminals[i]
    const pt = pg.terminals[i]
    if (t.command !== pt.command || t.commandMode !== pt.commandMode || t.color !== pt.color || (t.icon ?? 'terminal') !== (pt.icon ?? 'terminal')) return true
  }

  return false
}

// Auto-sync group name/color changes to linked pinned buttons + .clave files
useSessionStore.subscribe((state, prevState) => {
  if (state.groups === prevState.groups) return

  const pinnedGroups = usePinnedStore.getState().pinnedGroups
  let changed = false

  const updated = pinnedGroups.map((pg) => {
    if (!pg.activeGroupId) return pg
    const group = state.groups.find((g) => g.id === pg.activeGroupId)
    if (!group) return pg
    const newColor = group.color ?? null
    if (group.name !== pg.name || newColor !== pg.color) {
      changed = true
      return { ...pg, name: group.name, color: newColor }
    }
    return pg
  })

  if (changed) {
    usePinnedStore.setState({ pinnedGroups: updated })
    // Sync changed pins to .clave files
    for (const pg of updated) {
      if (pg.filePath) syncToClaveFile(pg)
    }
  }
})
