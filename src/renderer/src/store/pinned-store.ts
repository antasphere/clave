import { create } from 'zustand'
import { resourceKey, parseResourceKey } from '@clave/contract/fleet'
import { isRemoteKey } from '../lib/fleet-identity'
import { launchSession } from '../lib/launch-session'
import type { AgentSetup } from './launch-prefs'
import { resolveAccountRef, type AccountProvider } from '../lib/switch-account'
import { rememberedLaunchModel } from '../lib/launch-model'
import type { PinnedGroupRoutine } from './session-types'
import { getClaudeProfile } from './claude-profile-store'
import { useAccountPolicyStore } from './account-policy-store'
import { getCodexAccount } from './codex-account-store'
import { substituteTokens } from './prompt-tokens'
import type {
  PinnedGroup,
  PinnedGroupSession,
  PinnedGroupTerminal,
  GroupTerminalColor,
  GroupTerminalConfig,
  Session,
  SessionGroup
} from './session-types'
import { resolveGroupDefaults, resolveGroupLaunchCwd } from './group-defaults'
import { resolveDeclaredGroupView } from '../../../shared/group-view'
import { useSessionStore } from './session-store'
import { getActiveWorkspaceId, getWorkspaceById, workspaceServer } from './workspace-store'
import type { ClaveFileWriteData } from '../../../preload/index.d'

/** One group as `serializePin` writes it into a `.clave` file. */
type SerializedPin = NonNullable<ClaveFileWriteData['groups']>[number]

/** The `.clave` account field of a live session: its account's LABEL when it
 *  is not the Default (the file is shared between machines, ids are not). */
function pinnedAccountField(s: {
  claudeMode?: boolean
  claudeAgentsMode?: boolean
  codexMode?: boolean
  claudeProfileId?: string
  claudeProfileLabel?: string
  codexAccountId?: string
  codexAccountLabel?: string
}): { account?: string } {
  if (s.codexMode) {
    return s.codexAccountId && s.codexAccountId !== 'default' && s.codexAccountLabel
      ? { account: s.codexAccountLabel }
      : {}
  }
  if (s.claudeMode || s.claudeAgentsMode) {
    return s.claudeProfileId && s.claudeProfileId !== 'default' && s.claudeProfileLabel
      ? { account: s.claudeProfileLabel }
      : {}
  }
  return {}
}

/** The spawn and record fields for a pinned session's account (ADR 0002),
 *  the account judged for the model the session will run (PRDCT-4302). */
function resolvePinnedAccount(
  session: PinnedGroupSession,
  groupName: string,
  pinOtherProvider: boolean,
  model: string | undefined
): {
  claudeProfileId?: string
  claudeProfileLabel?: string
  codexAccountId?: string
  codexAccountLabel?: string
} {
  const provider: AccountProvider | null = session.codexMode
    ? 'codex'
    : session.claudeAgentsMode || (session.claudeMode && !pinOtherProvider)
      ? 'claude'
      : null
  if (!provider) return {}
  // With "Use the recommended account" on, a pinned group starts every agent
  // tab on the recommendation. The `account` a .clave carries is mostly the
  // one the tab happened to run on when the group was saved (pinnedAccountField
  // writes it from the live session), so honouring it replayed yesterday's
  // account instead of the one with the headroom.
  const ref = useAccountPolicyStore.getState().useRecommendedAccount ? undefined : session.account
  let account: { id: string; label: string }
  try {
    account = resolveAccountRef(provider, ref, model)
  } catch {
    account = provider === 'codex' ? getCodexAccount('default') : getClaudeProfile('default')
    void window.electronAPI?.showNotification?.({
      title: groupName,
      body: `Account "${session.account}" is not set up on this Mac: "${session.name}" starts on the Default account.`,
      sessionId: ''
    })
  }
  return provider === 'codex'
    ? { codexAccountId: account.id, codexAccountLabel: account.label }
    : { claudeProfileId: account.id, claudeProfileLabel: account.label }
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
  return groups.map(
    ({
      id,
      name,
      cwd,
      color,
      prompt,
      sessions,
      terminals,
      createdAt,
      filePath,
      rootDir,
      workspaceRoot,
      groupIndex,
      toolbar,
      logo,
      category,
      discoveredBy,
      workspaceId
    }) => ({
      id,
      name,
      cwd,
      color,
      prompt,
      sessions,
      terminals,
      createdAt,
      filePath,
      rootDir,
      workspaceRoot,
      groupIndex,
      toolbar,
      logo,
      category,
      discoveredBy,
      workspaceId
    })
  )
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
      pinnedGroups: s.pinnedGroups.map((pg) => (pg.id === pinnedId ? { ...pg, visible } : pg))
    })),

  updatePinnedGroup: (pinnedId, updates) =>
    set((s) => {
      const next = s.pinnedGroups.map((pg) => (pg.id === pinnedId ? { ...pg, ...updates } : pg))
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

      const serializePin = (p: PinnedGroup): SerializedPin => ({
        name: p.name,
        cwd: p.cwd,
        color: p.color,
        ...(p.toolbar ? { toolbar: true } : {}),
        ...(p.logo ? { logo: p.logo } : {}),
        ...(p.prompt ? { prompt: p.prompt } : {}),
        ...(p.view ? { view: p.view } : {}),
        sessions: p.sessions.map((s) => ({
          cwd: s.cwd,
          name: s.name,
          claudeMode: s.claudeMode,
          antigravityMode: s.antigravityMode,
          codexMode: s.codexMode,
          piMode: s.piMode,
          opencodeMode: s.opencodeMode,
          claudeAgentsMode: s.claudeAgentsMode,
          dangerousMode: s.dangerousMode,
          ...(s.prompt ? { prompt: s.prompt } : {}),
          ...(s.rootSession ? { rootSession: true } : {}),
          ...(s.account ? { account: s.account } : {})
        })),
        terminals: p.terminals.map((t) => ({
          command: t.command,
          commandMode: t.commandMode,
          color: t.color,
          icon: t.icon,
          cwd: t.cwd,
          autoLaunchLocalhost: t.autoLaunchLocalhost,
          persistent: t.persistent,
          serverUrl: t.serverUrl,
          groupView: t.groupView
        })),
        ...(p.routines?.length ? { routines: p.routines } : {}),
        ...(p.category ? { category: p.category } : {})
      })

      const writeData = isMulti
        ? { groups: pinsForFile.map(serializePin) }
        : serializePin(pinsForFile[0])

      // Use rootDir from the first pin for this file (all pins from same file share rootDir)
      const rootDirForFile = pinsForFile[0].rootDir ?? undefined
      window.electronAPI
        ?.writeClaveFile(fp, writeData, rootDirForFile)
        .catch((err) => console.error('[clave] Failed to write .clave file:', err))
    }
    pendingSyncs.clear()
    syncTimer = null
  }, 300)
}

// ── Import / Export ──

function createPinnedFromGroup(
  g: {
    name: string
    cwd: string
    color: string | null
    toolbar?: boolean
    category?: string
    logo?: string
    prompt?: string
    view?: string
    sessions: {
      cwd: string
      name: string
      claudeMode: boolean
      antigravityMode: boolean
      codexMode: boolean
      piMode?: boolean
      opencodeMode?: boolean
      claudeAgentsMode?: boolean
      dangerousMode: boolean
      prompt?: string
      rootSession?: boolean
      account?: string
    }[]
    terminals: {
      command: string
      commandMode: 'prefill' | 'auto'
      color: string
      icon?: string
      cwd?: string
      autoLaunchLocalhost?: boolean
      persistent?: boolean
      serverUrl?: string
      groupView?: boolean
    }[]
    routines?: PinnedGroupRoutine[]
  },
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
    ...(g.routines?.length ? { routines: g.routines } : {}),
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

function groupDataToPinnedTerminals(
  terminals: {
    command: string
    commandMode: 'prefill' | 'auto'
    color: string
    icon?: string
    cwd?: string
    autoLaunchLocalhost?: boolean
    persistent?: boolean
    serverUrl?: string
    groupView?: boolean
  }[]
): PinnedGroupTerminal[] {
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
export async function importClaveFile(
  filePath: string,
  options?: {
    autoLaunch?: boolean
    rootDir?: string
    discoveredBy?: string
    workspaceRoot?: string
    workspaceId?: string | null
  }
): Promise<{ pinnedId: string; alreadyExists: boolean } | null> {
  const rootDir = options?.rootDir
  const discoveredBy = options?.discoveredBy
  const workspaceRoot = options?.workspaceRoot
  const workspaceId = options?.workspaceId
  const result = await window.electronAPI?.readClaveFile(filePath, rootDir)
  if (!result) return null

  const autoLaunch = options?.autoLaunch ?? true

  // Normalize to array of groups
  const groups =
    result.type === 'multi'
      ? result.groups
      : [
          {
            name: result.name,
            cwd: result.cwd,
            color: result.color,
            toolbar: result.toolbar,
            category: result.category,
            logo: result.logo,
            prompt: result.prompt,
            sessions: result.sessions,
            terminals: result.terminals,
            routines: result.routines
          }
        ]

  // Check if already imported — reuse existing pins
  const existingPins = usePinnedStore
    .getState()
    .pinnedGroups.filter((pg) => pg.filePath === filePath)
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
          routines: (g.routines as PinnedGroupRoutine[] | undefined) ?? [],
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
      const pinned = createPinnedFromGroup(
        g,
        filePath,
        result.type === 'multi' ? i : undefined,
        rootDir,
        discoveredBy,
        workspaceRoot,
        workspaceId
      )
      usePinnedStore.getState().addPinnedGroup(pinned)
      if (autoLaunch) await togglePinnedGroup(pinned.id)
    }
    if (workspaceServer(workspaceId)) {
      for (const pin of existingPins.slice(groups.length))
        usePinnedStore.getState().removePinnedGroup(pin.id)
    }
    return { pinnedId: existingPins[0].id, alreadyExists: true }
  }

  // Fresh import
  window.electronAPI?.watchClaveFile(filePath).catch(() => {})

  let firstId: string | null = null
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const pinned = createPinnedFromGroup(
      g,
      filePath,
      result.type === 'multi' ? i : undefined,
      rootDir,
      discoveredBy,
      workspaceRoot,
      workspaceId
    )
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
export async function refreshWorkspacePins(ws: {
  id: string
  rootDir: string
  profileFile: string | null
}): Promise<void> {
  const keep = new Set<string>()
  const serverId = workspaceServer(ws.id)
  const rootKey = serverId ? resourceKey('file', serverId, ws.rootDir) : ws.rootDir
  let profileFile = ws.profileFile
  if (serverId) {
    if (profileFile) profileFile = resourceKey('file', serverId, profileFile)
    else {
      const discovered = await window.electronAPI.discoverClaveFiles(rootKey)
      profileFile =
        discovered.find((f) => f.name === 'default')?.path ??
        (discovered.length === 1 ? discovered[0].path : null)
    }
  }

  if (profileFile) {
    const exists = await window.electronAPI?.claveFileExists(profileFile)
    if (exists) {
      keep.add(profileFile)
      await importClaveFile(profileFile, {
        autoLaunch: false,
        rootDir: rootKey,
        workspaceRoot: ws.rootDir,
        workspaceId: ws.id
      })

      // Auto-discover repo .clave files when the profile enables it. The
      // discovery workspaceId hint prefers a same-named profile inside each
      // repo (romain.clave over default.clave for the "romain" profile).
      const adConfig = await window.electronAPI?.readAutoDiscoverConfig(profileFile)
      if (adConfig?.enabled) {
        const profileName = parseResourceKey('file', profileFile)
          .id.split(/[\\/]/)
          .pop()
          ?.replace('.clave', '')
        const discovered = await window.electronAPI?.discoverClaveFilesRecursive(rootKey, {
          ...adConfig,
          workspaceId: profileName && profileName !== 'default' ? profileName : undefined
        })
        for (const file of discovered ?? []) {
          if (file.path === profileFile) continue
          keep.add(file.path)
          await importClaveFile(file.path, {
            autoLaunch: false,
            rootDir: file.rootDir,
            discoveredBy: profileFile,
            workspaceRoot: ws.rootDir,
            workspaceId: ws.id
          })
        }
      }
    }
    // Profile file missing → keep persisted pins as-is (stale but functional);
    // Settings surfaces the warning. Pruning here would punish a transient
    // unmount (network volume, git checkout) by wiping the workspace.
    else if (!serverId) return
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

  // The workspace's file pins are now what its files say: the one moment the
  // saved copies of them can be told apart from the rest. Only after a real
  // read, so a workspace with no file yet keeps its one run for later.
  if (keep.size > 0) clearFilePinTwinsOnce(ws.id)
}

// ── The saved copies of a file pin, cleared once (PRDCT-4830) ──

/** The workspaces whose saved copies were cleared, kept beside the pins'
 *  other local flag: the clearing runs once per workspace on this Mac. */
const TWINS_CLEARED_KEY = 'clave-pin-twins-cleared'
/** The blueprints the clearing removed, so a removal that was wrong for
 *  someone can be put back by hand. */
const TWINS_REMOVED_KEY = 'clave-pin-twins-removed'

function readStoredList(key: string): unknown[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** The saved pins (no file) that double a file pin in `workspaceId`'s view:
 *  the same name and the same folder as a file-backed pin shown there. Until
 *  PRDCT-4830 pinning a group launched from a file pin saved a copy beside it,
 *  a photograph of the tabs open that day, unstamped, so it showed in every
 *  workspace: typing "clave" in the picker offered three "Clave". A saved pin
 *  with no file pin of its name and folder is someone's own, and is kept.
 *  Pure, so the rule is decidable without a window. */
export function filePinTwins(pins: PinnedGroup[], workspaceId: string): PinnedGroup[] {
  const shown = pins.filter((p) => pinShownIn(p, workspaceId))
  const filePins = shown.filter((p) => p.filePath)
  return shown.filter(
    (p) => !p.filePath && filePins.some((f) => f.name === p.name && sameFolder(f.cwd, p.cwd))
  )
}

/** Remove the saved copies of `workspaceId`'s file pins, once per workspace on
 *  this Mac. Once, not at every read: after it, a saved pin that shares a file
 *  pin's name and folder is one someone made on purpose (a file added later
 *  for a group they had pinned), and deleting it at some later boot would be
 *  a loss nobody asked for. Removing a pin never closes the tabs of a group it
 *  launched. The store's change is what writes the state file. */
function clearFilePinTwinsOnce(workspaceId: string): void {
  const cleared = readStoredList(TWINS_CLEARED_KEY)
  if (cleared.includes(workspaceId)) return
  const twins = filePinTwins(usePinnedStore.getState().pinnedGroups, workspaceId)
  try {
    // Recorded before anything is removed: a run that cannot be recorded as
    // done would run again at every boot, so it does not run at all.
    if (twins.length > 0) {
      localStorage.setItem(
        TWINS_REMOVED_KEY,
        JSON.stringify([...readStoredList(TWINS_REMOVED_KEY), ...serializePinnedGroups(twins)])
      )
    }
    localStorage.setItem(TWINS_CLEARED_KEY, JSON.stringify([...cleared, workspaceId]))
  } catch {
    return
  }
  for (const twin of twins) usePinnedStore.getState().removePinnedGroup(twin.id)
  if (twins.length > 0) {
    console.info(
      `[pinned] Removed ${twins.length} saved cop${twins.length === 1 ? 'y' : 'ies'} of a file pin (${[...new Set(twins.map((t) => t.name))].join(', ')}); kept under "${TWINS_REMOVED_KEY}".`
    )
  }
}

/** Get the default file name for a pinned group export */
export function getExportFileName(pinnedId: string): string {
  const pg = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pinnedId)
  if (!pg) return 'group.clave'
  return `${pg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.clave`
}

/** Export a pinned group to a .clave file at the specified path */
export async function exportClaveFile(
  pinnedId: string,
  folder: string,
  fileName: string,
  keepSynced: boolean
): Promise<void> {
  const pg = usePinnedStore.getState().pinnedGroups.find((p) => p.id === pinnedId)
  if (!pg) return

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
      opencodeMode: s.opencodeMode,
      claudeAgentsMode: s.claudeAgentsMode,
      dangerousMode: s.dangerousMode,
      ...(s.account ? { account: s.account } : {})
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
    ...(pg.routines?.length ? { routines: pg.routines } : {}),
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
    const groups =
      result.type === 'multi'
        ? result.groups
        : [
            {
              name: result.name,
              cwd: result.cwd,
              color: result.color,
              toolbar: result.toolbar,
              category: result.category,
              logo: result.logo,
              prompt: result.prompt,
              sessions: result.sessions,
              terminals: result.terminals,
              routines: result.routines
            }
          ]

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
          // The routines (ADR 0004) reload with the file like every other
          // field; the server reads the file itself to schedule them.
          routines: (g.routines as PinnedGroupRoutine[] | undefined) ?? [],
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
      const pinned = createPinnedFromGroup(
        g,
        filePath,
        result.type === 'multi' ? i : undefined,
        firstPin.rootDir,
        firstPin.discoveredBy,
        firstPin.workspaceRoot,
        firstPin.workspaceId
      )
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

// ── Pinning a live group ──

/** The live tabs of a group that are its own, not the sessions its group
 *  terminals run (those come back through the terminal configs). */
function groupTabs(group: SessionGroup, sessions: Session[]): Session[] {
  const terminalSessionIds = new Set(
    group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
  )
  return group.sessionIds
    .filter((sid) => !terminalSessionIds.has(sid))
    .map((sid) => sessions.find((s) => s.id === sid))
    .filter((s): s is Session => s !== undefined)
}

function isAgentTab(s: Session): boolean {
  return !!(
    s.claudeMode ||
    s.claudeAgentsMode ||
    s.codexMode ||
    s.antigravityMode ||
    s.piMode ||
    s.opencodeMode
  )
}

/** The blueprint of a live group as a pin records it (PRDCT-4830).
 *
 *  A pin keeps the GROUP: its name, folder, colour, prompt, root anchor and
 *  group terminals, the parts someone configured. It never photographs the tabs
 *  that happened to be open: those were throwaway names ("explore group
 *  placement", "Hackathon (resumed)") that came back on every launch of the pin
 *  and made it read as a list of old sessions. The pin holds ONE session, the
 *  group's default agent session: named after the group, opening where the
 *  group's `+` opens, on the harness and the permission mode of the group's
 *  first agent tab, the account by label (ADR 0002), starting on the group's
 *  prompt. A group with no agent tab gets a Claude tab.
 *
 *  Pure apart from its inputs, so the rule is decidable in a unit test.
 *  `null` when the group has no folder to open its tab in. */
export function blueprintFromGroup(
  group: SessionGroup,
  sessions: Session[],
  pins: PinnedGroup[],
  workspaceRoot: string | null
): Pick<
  PinnedGroup,
  'name' | 'cwd' | 'color' | 'prompt' | 'sessions' | 'terminals' | 'workspaceRoot'
> | null {
  const tabs = groupTabs(group, sessions)
  const agent = tabs.find(isAgentTab)
  // Where the group's `+` lands decides where the pin's tab opens; the rule
  // (and its fallback for groups stamped before the anchor was carried) is
  // resolveGroupLaunchCwd's.
  const atRoot = resolveGroupLaunchCwd(group, pins).kind === 'workspace-root'
  const cwd = group.cwd ?? workspaceRoot ?? agent?.cwd ?? tabs[0]?.cwd ?? null
  if (!cwd) return null
  const session: PinnedGroupSession = {
    name: group.name,
    cwd,
    claudeMode: agent ? agent.claudeMode : true,
    antigravityMode: agent?.antigravityMode ?? false,
    codexMode: agent?.codexMode ?? false,
    piMode: agent?.piMode ?? false,
    opencodeMode: agent?.opencodeMode ?? false,
    claudeAgentsMode: agent?.claudeAgentsMode ?? false,
    dangerousMode: agent?.dangerousMode ?? false,
    // The brief the tab starts on. A group-level prompt alone would reach only
    // the `+` of the stamped group, never the tab the stamp opens.
    ...(group.prompt ? { prompt: group.prompt } : {}),
    ...(atRoot ? { rootSession: true } : {}),
    ...(agent ? pinnedAccountField(agent) : {})
  }
  return {
    name: group.name,
    cwd: group.cwd ?? cwd,
    color: group.color ?? null,
    // Round-trips the group's default prompt the same way createPinnedFromGroup
    // does. Without it the trip is one-way: .clave → pin → group keeps the
    // prompt, group → pin → .clave silently loses it.
    prompt: group.prompt ?? null,
    sessions: [session],
    // Every authored field of each group terminal (the live config carries no
    // `persistent`, so there is nothing more to keep).
    terminals: group.terminals.map((t) => ({
      command: t.command,
      commandMode: t.commandMode,
      color: t.color,
      icon: t.icon,
      cwd: t.cwd,
      autoLaunchLocalhost: t.autoLaunchLocalhost,
      serverUrl: t.serverUrl,
      groupView: t.groupView
    })),
    // What a root-anchored tab opens in at launch (spawnPinnedGroup): without
    // it the anchor would be recorded and never honoured.
    workspaceRoot
  }
}

/** Whether a pin shows in `workspaceId`'s view. A pin carries a local id, so
 *  the rule every sidebar item obeys (`inActiveWorkspace`) comes down to this:
 *  a stamped pin shows in its own workspace, an unstamped one everywhere. */
function pinShownIn(pin: { workspaceId?: string | null }, workspaceId: string | null): boolean {
  return workspaceId === null || pin.workspaceId == null || pin.workspaceId === workspaceId
}

/** Whether the group picker lists this pin for `workspaceId`: the pins that
 *  are a toolbar's are its buttons, never a card. */
export function pinInPicker(pin: PinnedGroup, workspaceId: string | null): boolean {
  return !pin.toolbar && pinShownIn(pin, workspaceId)
}

const sameFolder = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? null) === (b ?? null)

/** The pin a live group already has among the ones the picker lists for
 *  `workspaceId` (PRDCT-4830), so pinning the group shows that pin instead of
 *  saving a copy beside it:
 *
 *  1. the pin it was launched from (`templateId`, stamped at launch whether or
 *     not the pin stays linked: the picker launches without a link, which is
 *     how a group dropped back onto the pins used to make a second "Clave");
 *  2. failing that, a pin of the same name and the same folder. That is what a
 *     copy would be, and it is the only trace left for a group launched before
 *     the stamp existed, or one whose stamp names a pin since read again from
 *     its file under a new id.
 *
 *  A pin the picker does not list here (another workspace's, a toolbar's)
 *  cannot be shown, so it does not count: pinning makes one for this view. */
export function findTemplateOfGroup(
  group: Pick<SessionGroup, 'name' | 'cwd' | 'templateId'>,
  pins: PinnedGroup[],
  workspaceId: string | null
): PinnedGroup | null {
  const listed = pins.filter((p) => pinInPicker(p, workspaceId))
  return (
    (group.templateId ? listed.find((p) => p.id === group.templateId) : undefined) ??
    listed.find((p) => p.name === group.name && sameFolder(p.cwd, group.cwd)) ??
    null
  )
}

/** The pin a live group already has: the one linked to it (it was pinned or
 *  toggled on in this run), else the one it came from (findTemplateOfGroup).
 *  null when pinning it would make a new pin. */
export function findPinOfGroup(groupId: string): PinnedGroup | null {
  const pins = usePinnedStore.getState().pinnedGroups
  const linked = pins.find((p) => p.activeGroupId === groupId)
  if (linked) return linked
  const group = useSessionStore.getState().groups.find((g) => g.id === groupId)
  return group ? findTemplateOfGroup(group, pins, getActiveWorkspaceId()) : null
}

/** Pin a live group: the group and one chat tab, never a photograph of its
 *  tabs (blueprintFromGroup). A group that already has a pin gets no second
 *  one: the answer names the pin it has (`created: false`), for the caller to
 *  show. null when there is nothing to pin (a server's group, an unknown one,
 *  a group with no folder). */
export function pinGroupFromCurrent(
  groupId: string
): { pinnedId: string; created: boolean } | null {
  if (isRemoteKey(groupId)) return null
  const { groups, sessions } = useSessionStore.getState()
  const group = groups.find((g) => g.id === groupId)
  if (!group) return null
  const existing = findPinOfGroup(groupId)
  if (existing) return { pinnedId: existing.id, created: false }

  // The pin belongs to the workspace its group lives in, never to all of them:
  // an unstamped pin lands in the state file's null partition and shows in
  // every workspace. Only a workspace of this Mac can be stamped. A saved pin
  // stamped with a server's workspace is never written to the state file (its
  // partitions hold the server's own file pins, read again at every boot), so
  // it would be gone at the next restart: on a server's workspace the pin
  // stays unstamped, as before, until saved pins have a place there.
  const workspaceId = group.workspaceId ?? getActiveWorkspaceId()
  const workspace = workspaceServer(workspaceId) ? undefined : getWorkspaceById(workspaceId)
  const blueprint = blueprintFromGroup(
    group,
    sessions,
    usePinnedStore.getState().pinnedGroups,
    workspace?.rootDir ?? null
  )
  if (!blueprint) return null

  const pinned: PinnedGroup = {
    id: crypto.randomUUID(),
    ...blueprint,
    createdAt: Date.now(),
    workspaceId: workspace?.id ?? null,
    // Link to the live group immediately — clicking won't respawn
    activeGroupId: groupId,
    visible: true
  }

  usePinnedStore.getState().addPinnedGroup(pinned)
  // The group remembers the pin made from it, as a group remembers the pin it
  // was launched from: the link above dies with the window, and after a
  // restart nothing else would say this group is pinned already.
  useSessionStore.setState((s) => ({
    groups: s.groups.map((g) => (g.id === groupId ? { ...g, templateId: pinned.id } : g))
  }))
  return { pinnedId: pinned.id, created: true }
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
  const serverId = workspaceServer(pg.workspaceId)
  if (serverId && pg.sessions.some((s) => s.account))
    console.info('[pinned] Server pin account labels use the server account pool.')
  // The model each provider's sessions will run (PRDCT-4302): a pinned
  // session names no model, so it starts on the one its family's selected
  // profile remembers, and its account is judged for that one.
  const launchModels = serverId
    ? { claude: undefined, codex: undefined }
    : {
        claude: await rememberedLaunchModel('claude', undefined, pg.workspaceId ?? null),
        codex: await rememberedLaunchModel('codex', undefined, pg.workspaceId ?? null)
      }

  for (const session of pg.sessions) {
    try {
      const pinOtherProvider =
        session.antigravityMode ||
        session.codexMode ||
        session.piMode ||
        session.opencodeMode ||
        session.claudeAgentsMode
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
      // The account (ADR 0002): what the file names by label, `any` or nothing
      // for the pool's pick — the same rule the launcher applies. A name this
      // Mac does not know falls back to the Default, and says so.
      if (serverId) {
        const kind: AgentSetup['kind'] | null = session.claudeAgentsMode
          ? 'claude-agents'
          : session.piMode
            ? 'pi'
            : session.opencodeMode
              ? 'opencode'
              : session.codexMode
                ? 'codex'
                : session.antigravityMode
                  ? 'antigravity'
                  : session.claudeMode
                    ? 'claude'
                    : null
        const id = await launchSession({
          serverId,
          cwd: { kind: 'path', path: spawnCwd },
          setup: kind ? { kind, dangerousMode: session.dangerousMode } : null,
          initialPrompt,
          workspaceId: pg.workspaceId ?? undefined,
          throwOnError: true
        })
        if (id) {
          useSessionStore.getState().renameSession(id, session.name)
          spawnedIds.push(id)
        }
        continue
      }
      const accountFields = resolvePinnedAccount(
        session,
        pg.name,
        !!pinOtherProvider,
        session.codexMode ? launchModels.codex : launchModels.claude
      )
      const sessionInfo = await window.electronAPI.spawnSession(spawnCwd, {
        claudeMode: pinOtherProvider ? false : session.claudeMode,
        antigravityMode: session.antigravityMode,
        codexMode: session.codexMode,
        piMode: session.piMode,
        opencodeMode: session.opencodeMode,
        claudeAgentsMode: session.claudeAgentsMode,
        dangerousMode: session.dangerousMode,
        initialPrompt,
        ...accountFields,
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
        opencodeMode: session.opencodeMode,
        claudeAgentsMode: session.claudeAgentsMode,
        dangerousMode: session.dangerousMode,
        ...accountFields,
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
            // Where the group came from, linked or not (the picker's stamp is
            // unlinked): what lets pinning it show this pin instead of saving
            // a copy of it.
            templateId: pinnedId,
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
  const pinVisible =
    pg.workspaceId == null || activeWorkspaceId == null || pg.workspaceId === activeWorkspaceId
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
export function getHiddenGroupIds(
  pinnedGroups: PinnedGroup[] = usePinnedStore.getState().pinnedGroups
): Set<string> {
  const ids = new Set<string>()
  for (const pg of pinnedGroups) {
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

/** Re-sync a pinned group's blueprint from the current live group state: the
 *  group (name, folder, colour, view) and its terminals. Never its tabs, for
 *  the reason pinning never copies them (blueprintFromGroup): the pin keeps
 *  the session it declares, and for a file pin that is what its `.clave`
 *  says, which a photograph of the open tabs used to overwrite. */
export function resyncPinnedGroup(groupId: string): void {
  const { groups } = useSessionStore.getState()
  const group = groups.find((g) => g.id === groupId)
  if (!group) return

  const pinnedGroups = usePinnedStore.getState().pinnedGroups
  const pg = pinnedGroups.find((p) => p.activeGroupId === groupId)
  if (!pg) return

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

/** Check if a pinned group's blueprint is out of sync with the live group.
 *  The tabs never count: a pin does not record them (blueprintFromGroup), so a
 *  group that opened a second tab is not a group that left its pin behind. */
export function isPinnedOutOfSync(groupId: string): boolean {
  const pg = findPinnedByGroupId(groupId)
  if (!pg) return false

  const { groups } = useSessionStore.getState()
  const group = groups.find((g) => g.id === groupId)
  if (!group) return false

  // Compare terminal count and configs
  if (group.terminals.length !== pg.terminals.length) return true
  for (let i = 0; i < group.terminals.length; i++) {
    const t = group.terminals[i]
    const pt = pg.terminals[i]
    if (
      t.command !== pt.command ||
      t.commandMode !== pt.commandMode ||
      t.color !== pt.color ||
      (t.icon ?? 'terminal') !== (pt.icon ?? 'terminal')
    )
      return true
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
