import { linkedEditorBlocksClose } from './linked-document-store'
import { emitTabClosed } from '../lib/exchange-capture'
import { create } from 'zustand'
import type { GitRangeDirection } from '../../../shared/git-range'
import type {
  Theme,
  AppIcon,
  Density,
  TreeRuleIntensity,
  PanelScope,
  ActivityStatus,
  GroupTerminalConfig,
  GroupTerminalColor,
  GroupTerminalIcon,
  GroupViewConfig,
  SessionViewConfig,
  Session,
  SessionGroup,
  FileTab,
  ActiveView,
  SettingsSection,
  ExtensionsSection,
  SessionType
} from './session-types'
import { PANEL_ROOTS, resolveDensity } from './session-types'
import type { Agent, AgentStatus } from '../../../shared/remote-types'
import { useWorkspaceStore } from './workspace-store'
import { mergeLayoutForKeys, absorbLayout, placeAdopted } from '../lib/sidebar-layout-partition'
import { moveLayoutItems } from '../lib/sidebar-layout-ops'
import { withDirToggled } from '../lib/panel-expansion'

// Re-export types and constants so existing imports continue to work
export type {
  Theme,
  AppIcon,
  ActivityStatus,
  GroupTerminalConfig,
  GroupTerminalColor,
  GroupTerminalIcon,
  GroupViewConfig,
  SessionViewConfig,
  Session,
  SessionGroup,
  FileTab,
  ActiveView,
  SettingsSection,
  ExtensionsSection,
  SessionType,
  TreeRuleIntensity,
  Density,
  PanelScope
}
export {
  GROUP_TERMINAL_COLORS,
  GROUP_TERMINAL_ICONS,
  TERMINAL_COLOR_VALUES,
  TREE_RULE_INTENSITIES,
  PANEL_ROOTS,
  DENSITY_LEVELS,
  DEFAULT_DENSITY,
  resolveDensity,
  resolveColorHex,
  treeRuleMultiplier,
  densityScale,
  densityIndex,
  panelRootLadder
} from './session-types'

/** THE visibility predicate — single source of truth for workspace scoping.
 *  activeId null → no-workspace mode, everything visible (today's app).
 *  x.workspaceId null/undefined → unstamped safety net: nothing can ever
 *  disappear because it predates the workspace model. */
export function inActiveWorkspace(
  x: { workspaceId?: string | null },
  activeId: string | null
): boolean {
  if (activeId === null) return true
  if (x.workspaceId == null) return true
  return x.workspaceId === activeId
}

interface SessionState {
  sessions: Session[]
  fileTabs: FileTab[]
  focusedSessionId: string | null
  selectedSessionIds: string[]
  groups: SessionGroup[]
  displayOrder: string[]
  /** Group whose attached web view fills the main pane instead of the session
   *  mosaic (set by clicking a group that has a view). Cleared by any explicit
   *  tab selection. Stale ids are harmless — the grid re-validates. */
  activeGroupViewId: string | null
  activeSessionViewId: string | null
  sidebarOpen: boolean
  sidebarWidth: number
  theme: Theme
  appIcon: AppIcon
  /** How heavily every tree draws the hairlines between its rows. */
  treeRuleIntensity: TreeRuleIntensity
  /** How tight the chrome is drawn — the stop `--density` is written from. */
  density: Density
  /** Run new sessions inside persistent tmux sessions. On by default; falls
   *  back to a plain shell automatically when tmux isn't installed. */
  tmuxMode: boolean
  /** The message trail: the floating box over a tab's terminal that shows
   *  where the conversation is. One switch for every tab. */
  messageTrailEnabled: boolean
  searchQuery: string
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  claudeAgentsMode: boolean
  dangerousMode: boolean
  filePaletteOpen: boolean
  fileTreeOpen: boolean
  fileTreeWidth: number
  fileTreeWidthOverride: number | null
  previewFile: string | null
  previewCwd: string | null
  previewSource: 'palette' | 'tree' | null
  previewLocationId: string | null
  diffPreview: {
    file: string
    cwd: string
    type: 'working' | 'commit' | GitRangeDirection
    staged: boolean
    fileStatus: string
    hash: string | null
    siblings?: Array<{ file: string; staged: boolean; fileStatus: string }>
    clickY?: number
  } | null
  gitRefreshTrigger: number
  collapseAllTrigger: number
  /** The folders the side panel has open, shared by BOTH its tabs.
   *
   *  Files and Git draw the same folders, and used to remember them apart: you
   *  browsed to a folder in Git, switched to Files, and landed at the root with
   *  the whole path to walk again. One panel, two views, one set.
   *
   *  Paths are RELATIVE to the panel's folder (the Files tree's own language —
   *  see panel-expansion.ts, which converts at the Git tab's absolute-path
   *  edge), and the sense is EXPANDED, so a folder one tab draws and the other
   *  does not is simply ignored there rather than read as open.
   *
   *  Keyed by panel folder, so re-rooting the panel gets that folder's own
   *  state back instead of another's. Session-lifetime, like the caches it
   *  replaced. */
  panelExpandedDirs: Record<string, Set<string>>
  activeView: ActiveView
  settingsSection: SettingsSection
  extensionsSection: ExtensionsSection
  sidePanelTab: 'files' | 'git' | 'help'
  gitViewMode: 'list' | 'tree'
  gitPanelMode: 'changes' | 'log'
  /** Per-repo commit bar (message box, commit, push/pull). Hidden by default —
   *  agents commit and push; the panel is for reading state. */
  gitShowCommitBar: boolean
  /** Above this many repos, the multi-repo git panel stops auto-polling and
   *  switches to event-driven + manual refresh (see use-multi-repo-status). */
  gitLivePollLimit: number
  /** When true, never pause live updates regardless of repo count. */
  gitLivePollAlways: boolean
  /** Which folder the side panel (Files and Git) opens a tab on — see
   *  PANEL_ROOTS. A preference for which rung to try first, not a fixed one:
   *  a tab with no folder on the chosen rung falls to the next (see
   *  panelRootLadder), and the panel's root chip still overrides it per tab. */
  defaultPanelRoot: PanelScope
  journeyPanel: { cwd: string; repoName: string } | null
  commitMessages: Record<string, string>
  generatingCommitCwds: Set<string>
  hiddenAgentIds: Set<string>
  sidebarUndoStack: SidebarSnapshot[]
  /** Last selection/focus per workspace, restored when switching back so each
   *  workspace feels like the tab set you left. Session-lifetime only. */
  workspaceSelections: Record<
    string,
    { selectedSessionIds: string[]; focusedSessionId: string | null }
  >
  /** Save the outgoing workspace's selection and restore (or initialize) the
   *  incoming one's. Pure view/selection change — sessions are untouched. */
  applyWorkspaceSwitch: (fromId: string | null, toId: string | null) => void
  /** Add a session as the sidebar's FIRST top-level row. Never nested: a
   *  session joins a group by being launched into one, not by the launch
   *  happening to catch a selection. */
  addSession: (session: Session) => void
  /** Add a session and place it in ONE step — as the first row inside
   *  `groupId`, or the first row of the sidebar when null. One step because a
   *  resume from the history dialog must land where it is told and
   *  subscribers (the history ledger's diff) must never see a transient
   *  placement in between. */
  addSessionInGroup: (session: Session, groupId: string | null) => void
  /** Add an ADOPTED session — a survivor at boot, a tab handed over by
   *  another window — without any placement heuristic: never nested into the
   *  selected group, never at the top level when a group (or a terminal, or
   *  a view) already holds it, no selection or focus change. */
  adoptSessionInPlace: (session: Session, options?: { focus?: boolean }) => void
  /** Add a session that is the HIDDEN HALF of something else — a group's
   *  quick-launch terminal, a session view's serving process. Never enters
   *  the top-level order and never takes focus; the caller links it to its
   *  owner in the same breath. The spawn paths inline this; the boot restore
   *  needs it as an action (see lib/adopt-record.ts). */
  addHiddenSession: (session: Session) => void
  removeSession: (id: string) => void
  /** Remove a tab because its session RE-HOMED to another window — drop it
   *  from this store WITHOUT killing the pty (it is alive, just moved). */
  removeSessionForRehome: (id: string) => void
  /** Drop a group because it MOVED whole to another window: its members that
   *  moved are already gone (removeSessionForRehome); any that stayed become
   *  plain tabs. Never touches a pty. */
  removeGroupForMove: (groupId: string) => void
  resetSessions: () => Promise<void>
  /** Replace the layout of the given workspaces (null = unscoped) with the
   *  one read from this window's file, pruned to `survivingSessionIds`
   *  (sessions that still exist — adopted here, or a record on disk), and
   *  leave every other workspace's groups untouched. The boot restore. */
  mergeLayoutForKeys: (
    keys: (string | null)[],
    persisted: { groups: SessionGroup[]; displayOrder: string[] },
    survivingSessionIds: string[]
  ) => void
  /** Take in groups handed over by another window (a closing window's
   *  sidebar, a group moved here): unknown groups and order entries are
   *  appended, known ones left alone. The members arrive through adoption. */
  absorbLayout: (incoming: { groups: SessionGroup[]; displayOrder: string[] }) => void
  selectSession: (id: string, addToSelection: boolean) => void
  selectSessions: (ids: string[]) => void
  setFocusedSession: (id: string) => void
  createGroup: (sessionIds: string[], name?: string, workspaceId?: string) => void
  ungroupSessions: (groupId: string) => void
  deleteGroup: (groupId: string) => void
  renameGroup: (groupId: string, name: string) => void
  toggleGroupCollapsed: (groupId: string) => void
  /** Attach (or clear, with null) a group's web view. */
  setGroupView: (groupId: string, view: GroupViewConfig | null) => void
  /** Show (or hide, with null) a group's web view in the main pane. */
  setActiveGroupView: (groupId: string | null) => void
  /** Attach (or clear, with null) a session's web view; persists to its record. */
  setSessionView: (sessionId: string, view: SessionViewConfig | null) => void
  /** Show (or hide, with null) a session's web view in the main pane. */
  setActiveSessionView: (sessionId: string | null) => void
  /** The dashboard-icon click: select the session AND show its view. */
  openSessionView: (sessionId: string) => void
  addGroupTerminal: (groupId: string, config: Omit<GroupTerminalConfig, 'sessionId'>) => void
  removeGroupTerminal: (groupId: string, terminalId: string) => void
  updateGroupTerminal: (
    groupId: string,
    terminalId: string,
    updates: Partial<
      Pick<
        GroupTerminalConfig,
        'command' | 'commandMode' | 'color' | 'icon' | 'serverUrl' | 'groupView'
      >
    >
  ) => void
  setGroupTerminalSessionId: (groupId: string, terminalId: string, sessionId: string | null) => void
  setGroupCwd: (groupId: string, cwd: string) => void
  setGroupColor: (groupId: string, color: GroupTerminalColor | null) => void
  /** Set (or clear, with null) the group's default prompt — what sessions
   *  launched from the group's own `+` start on. */
  setGroupPrompt: (groupId: string, prompt: string | null) => void
  /** Move rows or groups relative to `targetId`; `null` = the top level, at
   *  the end (the explicit ungroup). Rules in lib/sidebar-layout-ops.ts. */
  moveItems: (
    itemIds: string[],
    targetId: string | null,
    position: 'before' | 'after' | 'inside'
  ) => void
  undoSidebar: () => void
  toggleSidebar: () => void
  setSidebarWidth: (width: number) => void
  setTheme: (theme: Theme) => void
  setAppIcon: (icon: AppIcon) => void
  setTreeRuleIntensity: (intensity: TreeRuleIntensity) => void
  setDensity: (density: Density) => void
  setTmuxMode: (enabled: boolean) => void
  setMessageTrailEnabled: (enabled: boolean) => void
  updateSessionAlive: (id: string, alive: boolean) => void
  setSessionActivity: (id: string, status: ActivityStatus) => void
  setAgentState: (id: string, state: import('./session-types').AgentRunState) => void
  setSessionPromptWaiting: (id: string, promptType: string | null) => void
  setSessionDetectedUrl: (id: string, url: string | null) => void
  setSessionServerStatus: (id: string, status: import('./session-types').ServerStatus) => void
  setSessionServerCommand: (id: string, command: string | null) => void
  setSessionUnseenActivity: (id: string, unseen: boolean) => void
  setSessionInjectedFrom: (id: string, from: string | null) => void
  renameSession: (id: string, name: string) => void
  autoRenameSession: (id: string, name: string) => void
  resetSessionName: (id: string) => void
  setSessionPlanFile: (id: string, path: string) => void
  setSearchQuery: (query: string) => void
  toggleClaudeMode: () => void
  toggleAntigravityMode: () => void
  toggleCodexMode: () => void
  toggleClaudeAgentsMode: () => void
  toggleDangerousMode: () => void
  toggleFilePalette: () => void
  setFilePaletteOpen: (open: boolean) => void
  toggleFileTree: () => void
  setFileTreeWidth: (width: number) => void
  setFileTreeWidthOverride: (width: number | null) => void
  setActiveView: (view: ActiveView) => void
  setSettingsSection: (section: SettingsSection) => void
  /** Switch to the settings view, optionally jumping to a specific section. */
  openSettings: (section?: SettingsSection) => void
  setExtensionsSection: (section: ExtensionsSection) => void
  /** Switch to the extensions view, optionally jumping to a specific section. */
  openExtensions: (section?: ExtensionsSection) => void
  setSidePanelTab: (tab: 'files' | 'git' | 'help') => void
  setGitViewMode: (mode: 'list' | 'tree') => void
  setGitPanelMode: (mode: 'changes' | 'log') => void
  setGitShowCommitBar: (show: boolean) => void
  setGitLivePollLimit: (limit: number) => void
  setGitLivePollAlways: (always: boolean) => void
  setDefaultPanelRoot: (root: PanelScope) => void
  openJourneyPanel: (cwd: string, repoName: string) => void
  closeJourneyPanel: () => void
  setCommitMessage: (cwd: string, message: string) => void
  setGeneratingCommit: (cwd: string, generating: boolean) => void
  setPreviewFile: (
    path: string | null,
    source?: 'palette' | 'tree',
    cwd?: string | null,
    locationId?: string | null
  ) => void
  setDiffPreview: (preview: SessionState['diffPreview'], opts?: { fromJourney?: boolean }) => void
  triggerGitRefresh: () => void
  triggerCollapseAll: () => void
  /** Open or fold ONE folder of the panel's shared set, for the given panel
   *  folder. Expanding opens every folder on the way in and collapsing takes
   *  the subtree with it — both tabs draw compacted rows that stand for several
   *  segments at once (see withDirToggled). */
  setPanelDirExpanded: (
    basePath: string,
    relPath: string,
    expanded: boolean,
    /** How many folders the clicked row stood for: a Git row's compacted label
     *  counts its segments, a plain one-folder row counts 1. Folding clears
     *  that many from the leaf upwards, never the parents a user opened on
     *  their own. */
    segments?: number
  ) => void
  /** Replace the whole set for one panel folder — the Files tree's bulk paths
   *  (its own restore and refresh) come through here. */
  setPanelExpandedDirs: (basePath: string, dirs: Set<string>) => void
  addFileTab: (tab: FileTab) => void
  removeFileTab: (id: string) => void
  renameFileTab: (id: string, name: string) => void
  setFileTabDiffStaged: (id: string, staged: boolean) => void
  setClaudeSessionId: (id: string, claudeSessionId: string) => void
  addAgentSession: (agent: Agent, locationId: string) => void
  removeAgentSessions: (locationId: string) => void
  updateAgentSessionStatus: (agentId: string, locationId: string, status: AgentStatus) => void
  isAgentInSidebar: (agentId: string, locationId: string) => boolean
  hideAgentSession: (sessionId: string) => void
}

/** The defaults every session entering the store gets; the workspace stamp
 *  falls back to this window's active workspace (mirrors pty:spawn). */
function normalizeSession(session: Session): Session {
  const workspaceId =
    session.workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? undefined
  return {
    ...session,
    workspaceId,
    antigravityMode: session.antigravityMode ?? false,
    codexMode: session.codexMode ?? false,
    piMode: session.piMode ?? false,
    claudeAgentsMode: session.claudeAgentsMode ?? false,
    detectedUrl: session.detectedUrl ?? null,
    serverStatus: session.serverStatus ?? null,
    serverCommand: session.serverCommand ?? null,
    hasUnseenActivity: session.hasUnseenActivity ?? false,
    userRenamed: session.userRenamed ?? false,
    planFilePath: session.planFilePath ?? null
  }
}

let groupCounter = 0

// Groups (and the sidebar ordering that nests them) live only in memory during
// a run. tmux-backed sessions survive an app restart and get re-adopted, but
// the group objects that organize them would otherwise be lost. They are
// persisted from the main process (see sidebar-layout-manager) — written to a
// file synchronously on every change so they survive a hard kill (Ctrl+C /
// crash) that drops Chromium's lazily-flushed localStorage.
//
// Persistence stays disabled until `enableSidebarPersistence()` runs on launch,
// AFTER the previous layout has been read and groups restored. This prevents the
// empty initial state — written as sessions re-adopt — from clobbering the file
// before we've had a chance to load it.
let sidebarPersistEnabled = false
let lastPersistedGroups: SessionGroup[] | null = null
let lastPersistedOrder: string[] | null = null
/** The JSON last accepted by main — re-sent only on change. */
let lastPersistedJson: string | null = null

/** This window's whole sidebar, to its own file (one file per window — main
 *  resolves it from the sender). Every group carries its workspace stamp
 *  inside the file, so the window comes back showing the right ones. */
function persistSidebarLayout(state: { groups: SessionGroup[]; displayOrder: string[] }): void {
  const { groups, displayOrder } = state
  if (groups === lastPersistedGroups && displayOrder === lastPersistedOrder) return
  lastPersistedGroups = groups
  lastPersistedOrder = displayOrder
  const data = { groups, displayOrder }
  const json = JSON.stringify(data)
  if (json === lastPersistedJson) return
  window.electronAPI
    ?.sidebarLayoutSave?.(data)
    .then((res) => {
      if (res?.ok) lastPersistedJson = json
    })
    .catch(() => {
      // Persistence failures are non-fatal — groups stay in memory for this run.
    })
}

/** Mirror a session's tab name into its tmux sidecar (main process), so the
 *  rename survives a restart, a crash, or a reboot. The store itself lives in
 *  the renderer and dies with the window, which is why a renamed tab used to
 *  come back as its folder name. A name equal to the folder name is stored as
 *  "no name", so the tab tracks the folder if nothing was ever set. */
function persistSessionName(
  id: string,
  name: string,
  folderName: string,
  userRenamed: boolean
): void {
  window.electronAPI
    ?.setSessionDisplayName?.(id, name === folderName ? null : name, userRenamed)
    .catch(() => {
      // Non-fatal: the name still applies for this run, it just won't survive.
    })
}

/** Turn on sidebar-layout persistence. Call once on launch after the previous
 *  layout has been loaded (and groups restored), so re-adoption writes can't
 *  overwrite the saved file before we read it. */
export function enableSidebarPersistence(): void {
  sidebarPersistEnabled = true
  persistSidebarLayout(useSessionStore.getState())
}

type SidebarSnapshot = {
  groups: SessionGroup[]
  displayOrder: string[]
  selectedSessionIds: string[]
  focusedSessionId: string | null
}

const MAX_SIDEBAR_UNDO = 50

function cloneGroupsForSnapshot(groups: SessionGroup[]): SessionGroup[] {
  return groups.map((g) => ({
    ...g,
    sessionIds: [...g.sessionIds],
    terminals: g.terminals.map((t) => ({ ...t }))
  }))
}

function snapshotSidebar(state: {
  groups: SessionGroup[]
  sessions: Session[]
  displayOrder: string[]
  selectedSessionIds: string[]
  focusedSessionId: string | null
}): SidebarSnapshot {
  return {
    groups: cloneGroupsForSnapshot(state.groups),
    displayOrder: [...getDisplayOrder(state)],
    selectedSessionIds: [...state.selectedSessionIds],
    focusedSessionId: state.focusedSessionId
  }
}

function pushSidebarSnapshot(stack: SidebarSnapshot[], snap: SidebarSnapshot): SidebarSnapshot[] {
  const next =
    stack.length >= MAX_SIDEBAR_UNDO
      ? stack.slice(stack.length - MAX_SIDEBAR_UNDO + 1)
      : stack.slice()
  next.push(snap)
  return next
}

/** Flattened, workspace-filtered session id order — the one list behind
 *  Cmd+1..9 and Cmd+Shift+]/[ session cycling. Groups expand to their member
 *  sessions; anything outside the active workspace is skipped; file tabs are
 *  not sessions and never cycle. */
export function getVisibleFlatOrder(
  state: { sessions: Session[]; groups: SessionGroup[]; displayOrder: string[] },
  activeId: string | null
): string[] {
  const flatIds: string[] = []
  for (const id of getDisplayOrder(state)) {
    const group = state.groups.find((g) => g.id === id)
    if (group) {
      if (!inActiveWorkspace(group, activeId)) continue
      flatIds.push(...group.sessionIds)
      continue
    }
    const session = state.sessions.find((s) => s.id === id)
    if (session && inActiveWorkspace(session, activeId)) flatIds.push(id)
  }
  return flatIds
}

export function getDisplayOrder(state: {
  sessions: Session[]
  groups: SessionGroup[]
  displayOrder: string[]
}): string[] {
  if (state.displayOrder.length > 0) return [...state.displayOrder]
  const order: string[] = []
  const placedGroups = new Set<string>()
  for (const session of state.sessions) {
    const group = state.groups.find((g) => g.sessionIds.includes(session.id))
    if (group) {
      if (!placedGroups.has(group.id)) {
        placedGroups.add(group.id)
        order.push(group.id)
      }
    } else {
      order.push(session.id)
    }
  }
  return order
}

export function isFileTabId(id: string): boolean {
  return id.startsWith('file-')
}

export function fileTabDedupKey(tab: FileTab): string {
  if (tab.kind === 'diff' && tab.diff) {
    const suffix =
      tab.diff.type === 'working'
        ? `working-${tab.diff.staged ? 's' : 'u'}`
        : `commit-${tab.diff.hash ?? ''}`
    return `diff:${tab.diff.cwd}:${tab.diff.file}:${suffix}`
  }
  return `file:${tab.filePath}`
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  fileTabs: [],
  focusedSessionId: null,
  selectedSessionIds: [],
  groups: [],
  displayOrder: [],
  activeGroupViewId: null,
  activeSessionViewId: null,
  sidebarOpen: true,
  sidebarWidth: 260,
  theme: (localStorage.getItem('clave-theme') as Theme) || 'light',
  appIcon: (localStorage.getItem('clave-app-icon') as AppIcon) || 'dark',
  treeRuleIntensity:
    (localStorage.getItem('clave-tree-rule-intensity') as TreeRuleIntensity) || 'normal',
  density: resolveDensity(localStorage.getItem('clave-density')),
  tmuxMode: localStorage.getItem('clave-tmux-mode') !== 'false',
  messageTrailEnabled: localStorage.getItem('clave-message-trail') !== 'false',
  searchQuery: '',
  claudeMode: true,
  antigravityMode: false,
  codexMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  filePaletteOpen: false,
  fileTreeOpen: false,
  fileTreeWidth: 240,
  fileTreeWidthOverride: null,
  previewFile: null,
  previewCwd: null,
  previewSource: null,
  previewLocationId: null,
  diffPreview: null,
  gitRefreshTrigger: 0,
  collapseAllTrigger: 0,
  panelExpandedDirs: {} as Record<string, Set<string>>,
  activeView: 'terminals' as ActiveView,
  settingsSection: 'general' as SettingsSection,
  extensionsSection: 'marketplaces' as ExtensionsSection,
  sidePanelTab: 'files' as const,
  gitViewMode: (localStorage.getItem('clave-git-view-mode') === 'tree' ? 'tree' : 'list') as
    | 'list'
    | 'tree',
  gitPanelMode: 'changes' as const,
  gitShowCommitBar: localStorage.getItem('clave-git-commit-bar') === 'show',
  gitLivePollLimit: (() => {
    const raw = Number(localStorage.getItem('clave-git-live-poll-limit'))
    return Number.isFinite(raw) && raw > 0 ? raw : 50
  })(),
  gitLivePollAlways: localStorage.getItem('clave-git-live-poll-always') === 'true',
  defaultPanelRoot: (() => {
    const raw = localStorage.getItem('clave-panel-root-default')
    return PANEL_ROOTS.some((r) => r.id === raw) ? (raw as PanelScope) : 'group'
  })(),
  journeyPanel: null,
  commitMessages: {} as Record<string, string>,
  generatingCommitCwds: new Set<string>(),
  hiddenAgentIds: new Set<string>(
    JSON.parse(localStorage.getItem('clave-hidden-agent-ids') || '[]')
  ),
  sidebarUndoStack: [] as SidebarSnapshot[],
  workspaceSelections: {},
  applyWorkspaceSwitch: (fromId, toId) =>
    set((state) => {
      const workspaceSelections = { ...state.workspaceSelections }
      if (fromId) {
        workspaceSelections[fromId] = {
          selectedSessionIds: state.selectedSessionIds,
          focusedSessionId: state.focusedSessionId
        }
      }
      // Restore the target's saved selection, validated against live sessions;
      // fall back to the first visible session; else an empty selection.
      const visibleIds = new Set(
        state.sessions.filter((s) => inActiveWorkspace(s, toId)).map((s) => s.id)
      )
      const saved = toId ? workspaceSelections[toId] : undefined
      let selectedSessionIds = (saved?.selectedSessionIds ?? []).filter((id) => visibleIds.has(id))
      if (selectedSessionIds.length === 0) {
        const first = state.sessions.find((s) => inActiveWorkspace(s, toId))
        selectedSessionIds = first ? [first.id] : []
      }
      const focusedSessionId =
        saved?.focusedSessionId && visibleIds.has(saved.focusedSessionId)
          ? saved.focusedSessionId
          : (selectedSessionIds[0] ?? null)
      return { workspaceSelections, selectedSessionIds, focusedSessionId }
    }),
  addSession: (session) =>
    set((state) => {
      // Central workspace stamp: callers with a specific home pass it (pin
      // launches, MCP caller inheritance, adoption, duplicate/resume); everyone
      // else inherits the active workspace. Mirrors the pty:spawn-side default.
      const newSession = normalizeSession(session)

      // A spawn into a HIDDEN workspace (MCP background work) must not steal
      // the user's view: the sidebar already filters the tab out, so grabbing
      // selection/focus here would show its terminal pane over the active
      // workspace's world. Only visible spawns take focus.
      const visible = inActiveWorkspace(newSession, useWorkspaceStore.getState().activeWorkspaceId)
      const focusPatch = visible
        ? {
            selectedSessionIds: [session.id],
            focusedSessionId: session.id,
            activeView: 'terminals' as const
          }
        : {}

      // FIRST ROW, top level, always. A new tab used to be appended at the
      // bottom and, when the whole selection sat in one group, nested into
      // that group — so where a launch landed depended on where you happened
      // to be standing, and the thing you just asked for was the thing you
      // then had to go and find. It is the newest row now, at the top, where
      // the eye already is; a session that belongs in a group gets there by
      // being launched from that group's own `+` (addSessionInGroup), which
      // is a request rather than a guess.
      return {
        sessions: [...state.sessions, newSession],
        ...focusPatch,
        displayOrder: [session.id, ...getDisplayOrder(state)]
      }
    }),

  addSessionInGroup: (session, groupId) =>
    set((state) => {
      if (state.sessions.some((s) => s.id === session.id)) return state
      const newSession = normalizeSession(session)
      const visible = inActiveWorkspace(newSession, useWorkspaceStore.getState().activeWorkspaceId)
      const focusPatch = visible
        ? {
            selectedSessionIds: [session.id],
            focusedSessionId: session.id,
            activeView: 'terminals' as const
          }
        : {}
      const target = groupId ? state.groups.find((g) => g.id === groupId) : undefined
      // Top of wherever it lands — the group's first row, or the sidebar's,
      // the same rule addSession follows. A drag DROP onto a group still
      // appends (moveLayoutItems, position 'inside'): a hand aiming at a
      // group is placing the row, and it lands under what is already there.
      if (target) {
        return {
          sessions: [...state.sessions, newSession],
          ...focusPatch,
          groups: state.groups.map((g) =>
            g.id === target.id ? { ...g, sessionIds: [session.id, ...g.sessionIds] } : g
          ),
          displayOrder: getDisplayOrder(state)
        }
      }
      return {
        sessions: [...state.sessions, newSession],
        ...focusPatch,
        displayOrder: [session.id, ...getDisplayOrder(state)]
      }
    }),

  adoptSessionInPlace: (session, options) =>
    set((state) => {
      if (state.sessions.some((s) => s.id === session.id)) return state
      const newSession = normalizeSession(session)
      const withOrder = { ...state, displayOrder: getDisplayOrder(state) }
      // A deliberate move takes focus like a spawn — only when the tab is
      // visible here (its workspace shown); a hidden one never steals the view.
      const visible = inActiveWorkspace(newSession, useWorkspaceStore.getState().activeWorkspaceId)
      const focusPatch =
        options?.focus && visible
          ? {
              selectedSessionIds: [session.id],
              focusedSessionId: session.id,
              activeView: 'terminals' as const
            }
          : {}
      return {
        sessions: [...state.sessions, newSession],
        displayOrder: placeAdopted(withOrder, session.id),
        ...focusPatch
      }
    }),

  addHiddenSession: (session) =>
    set((state) =>
      state.sessions.some((s) => s.id === session.id)
        ? state
        : { sessions: [...state.sessions, normalizeSession(session)] }
    ),

  resetSessions: async () => {
    const { sessions, groups } = useSessionStore.getState()

    // The one app-initiated close: every tab goes, recorded as such. (An app
    // QUIT is not a close — sessions survive in tmux and are re-adopted.)
    for (const s of sessions) emitTabClosed(s, groups, 'app', null)

    // Kill all PTYs
    await Promise.allSettled(
      sessions.map((s) => window.electronAPI?.killSession(s.id).catch(() => {}))
    )

    set({
      sessions: [],
      groups: [],
      displayOrder: [],
      focusedSessionId: null,
      selectedSessionIds: [],
      searchQuery: ''
    })
  },

  mergeLayoutForKeys: (keys, persisted, survivingSessionIds) =>
    set((state) => {
      const merged = mergeLayoutForKeys(state, keys, persisted, survivingSessionIds)
      groupCounter = Math.max(groupCounter, merged.groups.length)
      return { ...state, groups: merged.groups, displayOrder: merged.displayOrder }
    }),

  absorbLayout: (incoming) =>
    set((state) => {
      const merged = absorbLayout(
        { groups: state.groups, displayOrder: getDisplayOrder(state) },
        incoming
      )
      groupCounter = Math.max(groupCounter, merged.groups.length)
      return { ...state, groups: merged.groups, displayOrder: merged.displayOrder }
    }),

  removeSessionForRehome: (id) =>
    set((state) => {
      // The session lives on in another window now; only detach it from THIS
      // store's tab list, groups, order and selection. Never touch the pty.
      const sessions = state.sessions.filter((s) => s.id !== id)
      const groups = state.groups.map((g) => ({
        ...g,
        sessionIds: g.sessionIds.filter((sid) => sid !== id),
        terminals: g.terminals.map((t) => (t.sessionId === id ? { ...t, sessionId: null } : t))
      }))
      return {
        sessions,
        groups,
        displayOrder: getDisplayOrder(state).filter((did) => did !== id),
        selectedSessionIds: state.selectedSessionIds.filter((sid) => sid !== id),
        focusedSessionId: state.focusedSessionId === id ? null : state.focusedSessionId
      }
    }),

  removeGroupForMove: (groupId) =>
    set((state) => {
      const group = state.groups.find((g) => g.id === groupId)
      if (!group) return state
      // Members and quick-launch terminals that could not move (not live,
      // not tmux-backed) stay here as plain tabs — never orphaned hidden.
      const linked = [
        ...group.sessionIds,
        ...group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
      ]
      const stayed = linked.filter((sid) => state.sessions.some((s) => s.id === sid))
      const order = getDisplayOrder(state).filter((did) => did !== groupId)
      return {
        groups: state.groups.filter((g) => g.id !== groupId),
        displayOrder: [...order, ...stayed.filter((sid) => !order.includes(sid))]
      }
    }),

  removeSession: (id) =>
    set((state) => {
      if (linkedEditorBlocksClose(id)) return state
      // A closed session takes its hidden serving session (session.view) with
      // it: nothing else owns that process, and an orphan would idle invisibly.
      const owner = state.sessions.find((s) => s.id === id)
      const servingId = owner?.view?.serverSessionId ?? null
      if (servingId) {
        window.electronAPI?.killSession?.(servingId).catch(() => {})
      }
      const sessions = state.sessions.filter((s) => s.id !== id && s.id !== servingId)
      const selectedSessionIds = state.selectedSessionIds.filter((sid) => sid !== id)
      const groups = state.groups.map((g) => ({
        ...g,
        sessionIds: g.sessionIds.filter((sid) => sid !== id),
        terminals: g.terminals.map((t) => (t.sessionId === id ? { ...t, sessionId: null } : t))
      }))
      const displayOrder = getDisplayOrder(state).filter((did) => did !== id)

      // Fallback focus stays inside the active workspace — closing the last
      // visible tab must never silently focus a hidden workspace's session.
      const activeId = useWorkspaceStore.getState().activeWorkspaceId
      const visibleSessions = sessions.filter((s) => inActiveWorkspace(s, activeId))

      let focusedSessionId = state.focusedSessionId
      if (focusedSessionId === id) {
        focusedSessionId =
          selectedSessionIds[0] ?? visibleSessions[visibleSessions.length - 1]?.id ?? null
      }
      const viewPatch = state.activeSessionViewId === id ? { activeSessionViewId: null } : {}
      if (selectedSessionIds.length === 0 && visibleSessions.length > 0) {
        const lastId = visibleSessions[visibleSessions.length - 1].id
        return {
          sessions,
          selectedSessionIds: [lastId],
          focusedSessionId: lastId,
          groups,
          displayOrder,
          ...viewPatch
        }
      }

      return { sessions, selectedSessionIds, focusedSessionId, groups, displayOrder, ...viewPatch }
    }),

  selectSession: (id, addToSelection) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      const targetView: ActiveView = session?.sessionType === 'agent' ? 'agents' : 'terminals'
      // Clear unseen activity + the cross-tab injected marker when viewed
      const sessions =
        session?.hasUnseenActivity || session?.injectedFrom
          ? state.sessions.map((s) =>
              s.id === id ? { ...s, hasUnseenActivity: false, injectedFrom: null } : s
            )
          : state.sessions
      if (addToSelection) {
        const isSelected = state.selectedSessionIds.includes(id)
        const newSelected = isSelected
          ? state.selectedSessionIds.filter((sid) => sid !== id)
          : [...state.selectedSessionIds, id]
        const focusedSessionId = isSelected ? (newSelected[0] ?? null) : id
        return {
          sessions,
          selectedSessionIds: newSelected,
          focusedSessionId,
          activeView: targetView,
          activeGroupViewId: null,
          activeSessionViewId: null
        }
      }
      return {
        sessions,
        selectedSessionIds: [id],
        focusedSessionId: id,
        activeView: targetView,
        activeGroupViewId: null,
        activeSessionViewId: null
      }
    }),

  selectSessions: (ids) =>
    set(() => ({
      selectedSessionIds: ids,
      focusedSessionId: ids[0] ?? null,
      activeView: 'terminals' as ActiveView,
      activeGroupViewId: null,
      activeSessionViewId: null
    })),

  setFocusedSession: (id) => set(() => ({ focusedSessionId: id })),

  createGroup: (sessionIds, name?, workspaceId?) =>
    set((state) => {
      const sidebarUndoStack = pushSidebarSnapshot(state.sidebarUndoStack, snapshotSidebar(state))
      groupCounter++
      const groupName = name || `Group ${groupCounter}`
      const firstSession = state.sessions.find((s) => sessionIds.includes(s.id))
      const newGroup: SessionGroup = {
        id: `group-${Date.now()}-${groupCounter}`,
        name: groupName,
        sessionIds: [...sessionIds],
        collapsed: false,
        cwd: firstSession?.cwd ?? null,
        terminals: [],
        // Explicit stamp > first member's home > the active workspace.
        workspaceId:
          workspaceId ??
          firstSession?.workspaceId ??
          useWorkspaceStore.getState().activeWorkspaceId ??
          undefined
      }
      // Remove these sessions from any existing groups
      const groups = state.groups.map((g) => ({
        ...g,
        sessionIds: g.sessionIds.filter((sid) => !sessionIds.includes(sid))
      }))

      // Update displayOrder: replace first session with group ID, remove rest
      let displayOrder = getDisplayOrder(state)
      let inserted = false
      displayOrder = displayOrder.reduce<string[]>((acc, id) => {
        if (sessionIds.includes(id)) {
          if (!inserted) {
            inserted = true
            acc.push(newGroup.id)
          }
        } else {
          acc.push(id)
        }
        return acc
      }, [])
      if (!inserted) displayOrder.push(newGroup.id)

      return { groups: [...groups, newGroup], displayOrder, sidebarUndoStack }
    }),

  ungroupSessions: (groupId) =>
    set((state) => {
      const group = state.groups.find((g) => g.id === groupId)
      if (!group) return {}
      const sidebarUndoStack = pushSidebarSnapshot(state.sidebarUndoStack, snapshotSidebar(state))

      // The members become tabs; the quick-launch terminals do not — a
      // terminal belongs to its group and is stopped with it (the caller,
      // lib/group-dissolve.ts, kills the processes; this drops the sessions
      // so they cannot linger invisibly outside any order, PRDCT-2038).
      const terminalSessionIds = new Set(
        group.terminals.map((t) => t.sessionId).filter((id): id is string => id !== null)
      )
      const sessions = state.sessions.filter((s) => !terminalSessionIds.has(s.id))
      const selectedSessionIds = state.selectedSessionIds.filter(
        (sid) => !terminalSessionIds.has(sid)
      )
      const focusedSessionId =
        state.focusedSessionId && terminalSessionIds.has(state.focusedSessionId)
          ? (selectedSessionIds[0] ?? null)
          : state.focusedSessionId

      // Replace group ID in displayOrder with its session IDs
      const displayOrder = getDisplayOrder(state).filter((did) => !terminalSessionIds.has(did))
      const idx = displayOrder.indexOf(groupId)
      if (idx !== -1) {
        // A member that is also a terminal was killed above: never back in the order.
        displayOrder.splice(idx, 1, ...group.sessionIds.filter((id) => !terminalSessionIds.has(id)))
      }

      return {
        sessions,
        selectedSessionIds,
        focusedSessionId,
        groups: state.groups.filter((g) => g.id !== groupId),
        displayOrder,
        sidebarUndoStack
      }
    }),

  deleteGroup: (groupId) =>
    set((state) => {
      const group = state.groups.find((g) => g.id === groupId)
      if (!group) return {}

      const terminalSessionIds = group.terminals
        .map((t) => t.sessionId)
        .filter((id): id is string => id !== null)
      const sessionIdsToRemove = new Set([...group.sessionIds, ...terminalSessionIds])
      const sessions = state.sessions.filter((s) => !sessionIdsToRemove.has(s.id))
      const selectedSessionIds = state.selectedSessionIds.filter(
        (sid) => !sessionIdsToRemove.has(sid)
      )
      const displayOrder = getDisplayOrder(state).filter(
        (did) => did !== groupId && !sessionIdsToRemove.has(did)
      )
      const groups = state.groups.filter((g) => g.id !== groupId)

      let focusedSessionId = state.focusedSessionId
      if (focusedSessionId && sessionIdsToRemove.has(focusedSessionId)) {
        focusedSessionId = selectedSessionIds[0] ?? sessions[sessions.length - 1]?.id ?? null
      }
      if (selectedSessionIds.length === 0 && sessions.length > 0) {
        const lastId = sessions[sessions.length - 1].id
        return {
          sessions,
          selectedSessionIds: [lastId],
          focusedSessionId: lastId,
          groups,
          displayOrder
        }
      }

      return { sessions, selectedSessionIds, focusedSessionId, groups, displayOrder }
    }),

  renameGroup: (groupId, name) =>
    set((state) => {
      const target = state.groups.find((g) => g.id === groupId)
      const nextName = name.trim() || 'Group'
      if (!target || target.name === nextName) return {}
      const sidebarUndoStack = pushSidebarSnapshot(state.sidebarUndoStack, snapshotSidebar(state))
      return {
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, name: nextName } : g)),
        sidebarUndoStack
      }
    }),

  toggleGroupCollapsed: (groupId) =>
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
    })),

  setGroupView: (groupId, view) =>
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, view } : g)),
      // Clearing a view that is currently showing drops back to the mosaic.
      ...(view === null && state.activeGroupViewId === groupId ? { activeGroupViewId: null } : {})
    })),

  setActiveGroupView: (groupId) =>
    set(() => ({
      activeGroupViewId: groupId,
      ...(groupId !== null ? { activeSessionViewId: null } : {})
    })),

  setSessionView: (sessionId, view) => {
    // The record (main process) is what survives a restart — renderer state
    // dies with the window, same rationale as persistSessionName. The serving
    // session id is deliberately not persisted: it never survives a restart,
    // and the start action respawns from `command`.
    window.electronAPI
      ?.setSessionViewRecord?.(
        sessionId,
        view ? { url: view.url, title: view.title, command: view.command, cwd: view.cwd } : null
      )
      .catch(() => {})
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, view } : s)),
      // Clearing the view that is currently showing drops back to the terminal.
      ...(view === null && state.activeSessionViewId === sessionId
        ? { activeSessionViewId: null }
        : {})
    }))
  },

  setActiveSessionView: (sessionId) =>
    set(() => ({
      activeSessionViewId: sessionId,
      ...(sessionId !== null ? { activeGroupViewId: null } : {})
    })),

  openSessionView: (sessionId) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === sessionId)
      if (!session?.view) return state
      return {
        selectedSessionIds: [sessionId],
        focusedSessionId: sessionId,
        activeView: 'terminals' as ActiveView,
        activeGroupViewId: null,
        activeSessionViewId: sessionId
      }
    }),

  addGroupTerminal: (groupId, config) =>
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId ? { ...g, terminals: [...g.terminals, { ...config, sessionId: null }] } : g
      )
    })),

  removeGroupTerminal: (groupId, terminalId) =>
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId ? { ...g, terminals: g.terminals.filter((t) => t.id !== terminalId) } : g
      )
    })),

  updateGroupTerminal: (groupId, terminalId, updates) =>
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              terminals: g.terminals.map((t) => (t.id === terminalId ? { ...t, ...updates } : t))
            }
          : g
      )
    })),

  setGroupTerminalSessionId: (groupId, terminalId, sessionId) =>
    set((state) => ({
      groups: state.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              terminals: g.terminals.map((t) => (t.id === terminalId ? { ...t, sessionId } : t))
            }
          : g
      )
    })),

  setGroupCwd: (groupId, cwd) =>
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, cwd } : g))
    })),

  setGroupPrompt: (groupId, prompt) =>
    set((state) => {
      const target = state.groups.find((g) => g.id === groupId)
      const next = prompt && prompt.trim() ? prompt : null
      if (!target || (target.prompt ?? null) === next) return {}
      const sidebarUndoStack = pushSidebarSnapshot(state.sidebarUndoStack, snapshotSidebar(state))
      return {
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, prompt: next } : g)),
        sidebarUndoStack
      }
    }),

  setGroupColor: (groupId, color) =>
    set((state) => {
      const target = state.groups.find((g) => g.id === groupId)
      if (!target || target.color === color) return {}
      const sidebarUndoStack = pushSidebarSnapshot(state.sidebarUndoStack, snapshotSidebar(state))
      return {
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, color } : g)),
        sidebarUndoStack
      }
    }),

  moveItems: (itemIds, targetId, position) =>
    set((state) => {
      // The structural rules live in moveLayoutItems (pure, unit-tested):
      // one place per id, no group inside a group, only a group emptied by
      // this move is dropped. A no-op drop records no undo step.
      const next = moveLayoutItems(
        { groups: state.groups, displayOrder: getDisplayOrder(state) },
        itemIds,
        targetId,
        position
      )
      if (!next) return {}
      const sidebarUndoStack = pushSidebarSnapshot(state.sidebarUndoStack, snapshotSidebar(state))
      return { displayOrder: next.displayOrder, groups: next.groups, sidebarUndoStack }
    }),

  undoSidebar: () =>
    set((state) => {
      if (state.sidebarUndoStack.length === 0) return {}
      const snap = state.sidebarUndoStack[state.sidebarUndoStack.length - 1]
      const sidebarUndoStack = state.sidebarUndoStack.slice(0, -1)
      const validSessionIds = new Set(state.sessions.map((s) => s.id))
      const restoredGroups = snap.groups
        .map((g) => ({
          ...g,
          sessionIds: g.sessionIds.filter((sid) => validSessionIds.has(sid)),
          terminals: g.terminals.map((t) => ({
            ...t,
            sessionId: t.sessionId && validSessionIds.has(t.sessionId) ? t.sessionId : null
          }))
        }))
      // A restored group whose members have since closed comes back empty —
      // an empty group is a normal state, exactly as closing its last tab
      // leaves it (see mergeLayoutForKeys).
      const restoredGroupIds = new Set(restoredGroups.map((g) => g.id))
      const displayOrder = snap.displayOrder.filter(
        (id) => validSessionIds.has(id) || restoredGroupIds.has(id)
      )
      const focusedSessionId =
        snap.focusedSessionId && validSessionIds.has(snap.focusedSessionId)
          ? snap.focusedSessionId
          : state.focusedSessionId
      const selectedSessionIds = snap.selectedSessionIds.filter((sid) => validSessionIds.has(sid))
      return {
        groups: restoredGroups,
        displayOrder,
        focusedSessionId,
        selectedSessionIds:
          selectedSessionIds.length > 0 ? selectedSessionIds : state.selectedSessionIds,
        sidebarUndoStack
      }
    }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(180, Math.min(480, width)) }),

  setTheme: (theme) => {
    localStorage.setItem('clave-theme', theme)
    set({ theme })
  },

  setTreeRuleIntensity: (treeRuleIntensity) => {
    localStorage.setItem('clave-tree-rule-intensity', treeRuleIntensity)
    set({ treeRuleIntensity })
  },

  setDensity: (density) => {
    localStorage.setItem('clave-density', density)
    set({ density })
  },

  setAppIcon: (appIcon) => {
    localStorage.setItem('clave-app-icon', appIcon)
    set({ appIcon })
    window.electronAPI?.setAppIcon(appIcon)
  },

  setTmuxMode: (tmuxMode) => {
    localStorage.setItem('clave-tmux-mode', String(tmuxMode))
    set({ tmuxMode })
    // Persist to the main process too: pty:spawn reads this as the default.
    window.electronAPI?.preferencesSet('tmuxMode', tmuxMode)
  },

  setMessageTrailEnabled: (messageTrailEnabled) => {
    localStorage.setItem('clave-message-trail', String(messageTrailEnabled))
    set({ messageTrailEnabled })
  },

  updateSessionAlive: (id, alive) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, alive, ...(!alive && { activityStatus: 'ended' as const }) } : s
      )
    })),

  setSessionActivity: (id, status) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session || session.activityStatus === status) return state
      return {
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, activityStatus: status } : s))
      }
    }),

  setAgentState: (id, agentState) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session || session.agentState === agentState) return state
      return {
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, agentState } : s))
      }
    }),

  setSessionPromptWaiting: (id, promptType) =>
    set((state) => {
      // Called on every PTY data chunk; bail when unchanged so we don't allocate
      // a new sessions array (and re-render every subscriber) tens of times/sec.
      const session = state.sessions.find((s) => s.id === id)
      if (!session || session.promptWaiting === promptType) return state
      return {
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, promptWaiting: promptType } : s))
      }
    }),

  setSessionDetectedUrl: (id, url) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session) return state
      // Skip if URL unchanged AND already running (avoid unnecessary re-renders)
      if (session.detectedUrl === url && (!url || session.serverStatus === 'running')) return state

      // Auto-launch localhost if the session's terminal config has the flag
      if (url && window.electronAPI?.openExternal) {
        const group = state.groups.find((g) => g.terminals.some((t) => t.sessionId === id))
        const terminal = group?.terminals.find((t) => t.sessionId === id)
        if (terminal?.autoLaunchLocalhost) {
          window.electronAPI.openExternal(url)
        }
      }

      return {
        sessions: state.sessions.map((s) =>
          s.id === id
            ? { ...s, detectedUrl: url, serverStatus: url ? 'running' : s.serverStatus }
            : s
        )
      }
    }),

  setSessionServerStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, serverStatus: status } : s))
    })),

  setSessionServerCommand: (id, command) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, serverCommand: command } : s))
    })),

  setSessionUnseenActivity: (id, unseen) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session || session.hasUnseenActivity === unseen) return state
      return {
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, hasUnseenActivity: unseen } : s))
      }
    }),

  setSessionInjectedFrom: (id, from) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session || (session.injectedFrom ?? null) === from) return state
      return {
        sessions: state.sessions.map((s) => (s.id === id ? { ...s, injectedFrom: from } : s))
      }
    }),

  renameSession: (id, name) => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === id)
    if (!session) return
    const next = name.trim() || session.folderName
    persistSessionName(id, next, session.folderName, true)
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, name: next, userRenamed: true } : s
      )
    }))
  },

  autoRenameSession: (id, name) => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === id)
    if (!session || session.userRenamed) return
    const next = name.trim() || session.name
    persistSessionName(id, next, session.folderName, false)
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, name: next } : s))
    }))
  },

  resetSessionName: (id) => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === id)
    if (session) persistSessionName(id, session.folderName, session.folderName, false)
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, name: s.folderName, userRenamed: false } : s
      )
    }))
  },

  setSessionPlanFile: (id, path) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, planFilePath: path } : s))
    })),

  setSearchQuery: (query) => set({ searchQuery: query }),

  toggleClaudeMode: () => set((state) => ({ claudeMode: !state.claudeMode })),

  toggleAntigravityMode: () => set((state) => ({ antigravityMode: !state.antigravityMode })),

  toggleCodexMode: () => set((state) => ({ codexMode: !state.codexMode })),

  toggleClaudeAgentsMode: () => set((state) => ({ claudeAgentsMode: !state.claudeAgentsMode })),

  toggleDangerousMode: () => set((state) => ({ dangerousMode: !state.dangerousMode })),

  toggleFilePalette: () => set((state) => ({ filePaletteOpen: !state.filePaletteOpen })),

  setFilePaletteOpen: (open) => set({ filePaletteOpen: open }),

  toggleFileTree: () => set((state) => ({ fileTreeOpen: !state.fileTreeOpen })),

  setFileTreeWidth: (width) => set({ fileTreeWidth: Math.max(180, Math.min(400, width)) }),

  setFileTreeWidthOverride: (width) => set({ fileTreeWidthOverride: width }),

  setActiveView: (view) => set({ activeView: view }),

  setSettingsSection: (section) => set({ settingsSection: section }),

  openSettings: (section) =>
    set((state) => ({
      activeView: 'settings',
      settingsSection: section ?? state.settingsSection
    })),

  setExtensionsSection: (section) => set({ extensionsSection: section }),

  openExtensions: (section) =>
    set((state) => ({
      activeView: 'extensions',
      extensionsSection: section ?? state.extensionsSection
    })),

  setSidePanelTab: (tab) => set({ sidePanelTab: tab }),

  setGitViewMode: (mode) => {
    localStorage.setItem('clave-git-view-mode', mode)
    set({ gitViewMode: mode })
  },

  setGitPanelMode: (mode) => set({ gitPanelMode: mode }),

  setGitShowCommitBar: (show) => {
    localStorage.setItem('clave-git-commit-bar', show ? 'show' : 'hide')
    set({ gitShowCommitBar: show })
  },

  setGitLivePollLimit: (limit) => {
    const clamped = Math.max(1, Math.round(limit))
    localStorage.setItem('clave-git-live-poll-limit', String(clamped))
    set({ gitLivePollLimit: clamped })
  },

  setGitLivePollAlways: (always) => {
    localStorage.setItem('clave-git-live-poll-always', String(always))
    set({ gitLivePollAlways: always })
  },

  setDefaultPanelRoot: (root) => {
    localStorage.setItem('clave-panel-root-default', root)
    set({ defaultPanelRoot: root })
  },

  openJourneyPanel: (cwd, repoName) =>
    set({
      journeyPanel: { cwd, repoName },
      diffPreview: null,
      previewFile: null,
      previewCwd: null,
      previewSource: null,
      previewLocationId: null
    }),

  closeJourneyPanel: () => set({ journeyPanel: null, diffPreview: null }),

  setCommitMessage: (cwd, message) =>
    set((state) => ({
      commitMessages: { ...state.commitMessages, [cwd]: message }
    })),

  setGeneratingCommit: (cwd, generating) =>
    set((state) => {
      const next = new Set(state.generatingCommitCwds)
      if (generating) next.add(cwd)
      else next.delete(cwd)
      return { generatingCommitCwds: next }
    }),

  setPreviewFile: (path, source, cwd, locationId) =>
    set((state) => ({
      previewFile: path,
      previewCwd: cwd ?? null,
      previewSource: source ?? null,
      previewLocationId: locationId ?? null,
      diffPreview: path ? null : state.diffPreview
    })),

  setDiffPreview: (preview, opts) =>
    set({
      diffPreview: preview,
      ...(preview
        ? { previewFile: null, previewCwd: null, previewSource: null, previewLocationId: null }
        : {}),
      ...(preview && !opts?.fromJourney ? { journeyPanel: null } : {})
    }),

  triggerGitRefresh: () => set((state) => ({ gitRefreshTrigger: state.gitRefreshTrigger + 1 })),

  triggerCollapseAll: () =>
    set((state) => ({
      collapseAllTrigger: state.collapseAllTrigger + 1,
      // Collapse-all empties the shared set as well as bumping the trigger.
      // The trigger alone told each tree to fold its own state; with one set
      // behind both, the set IS the state, and a tree that re-derived from a
      // stale set would unfold again on the next render.
      panelExpandedDirs: {}
    })),

  setPanelDirExpanded: (basePath, relPath, expanded, segments = 1) =>
    set((state) => ({
      panelExpandedDirs: {
        ...state.panelExpandedDirs,
        [basePath]: withDirToggled(
          state.panelExpandedDirs[basePath] ?? new Set<string>(),
          relPath,
          expanded,
          segments
        )
      }
    })),

  setPanelExpandedDirs: (basePath, dirs) =>
    set((state) => ({
      panelExpandedDirs: { ...state.panelExpandedDirs, [basePath]: dirs }
    })),

  addFileTab: (tab) =>
    set((state) => {
      const key = fileTabDedupKey(tab)
      const existing = state.fileTabs.find((f) => fileTabDedupKey(f) === key)
      if (existing) {
        return {
          // A re-open with an explicit view mode retargets the existing tab.
          ...(tab.view && tab.view !== existing.view
            ? {
                fileTabs: state.fileTabs.map((f) =>
                  f.id === existing.id ? { ...f, view: tab.view } : f
                )
              }
            : {}),
          selectedSessionIds: [existing.id],
          focusedSessionId: existing.id,
          activeView: 'terminals' as ActiveView,
          activeGroupViewId: null,
          activeSessionViewId: null
        }
      }
      return {
        fileTabs: [...state.fileTabs, tab],
        displayOrder: [...getDisplayOrder(state), tab.id],
        selectedSessionIds: [tab.id],
        focusedSessionId: tab.id,
        activeView: 'terminals' as ActiveView,
        activeGroupViewId: null,
        activeSessionViewId: null
      }
    }),

  removeFileTab: (id) =>
    set((state) => {
      const fileTabs = state.fileTabs.filter((f) => f.id !== id)
      const selectedSessionIds = state.selectedSessionIds.filter((sid) => sid !== id)
      const displayOrder = getDisplayOrder(state).filter((did) => did !== id)
      const groups = state.groups.map((g) => ({
        ...g,
        sessionIds: g.sessionIds.filter((sid) => sid !== id)
      }))

      let focusedSessionId = state.focusedSessionId
      if (focusedSessionId === id) {
        focusedSessionId =
          selectedSessionIds[0] ?? state.sessions[state.sessions.length - 1]?.id ?? null
      }
      if (selectedSessionIds.length === 0 && state.sessions.length > 0) {
        const lastId = state.sessions[state.sessions.length - 1].id
        return {
          fileTabs,
          selectedSessionIds: [lastId],
          focusedSessionId: lastId,
          groups,
          displayOrder
        }
      }

      return { fileTabs, selectedSessionIds, focusedSessionId, groups, displayOrder }
    }),

  renameFileTab: (id, name) =>
    set((state) => ({
      fileTabs: state.fileTabs.map((f) =>
        f.id === id ? { ...f, name: name.trim() || f.filePath.split(/[\\/]/).pop() || 'file' } : f
      )
    })),

  setFileTabDiffStaged: (id, staged) =>
    set((state) => ({
      fileTabs: state.fileTabs.map((f) =>
        f.id === id && f.diff ? { ...f, diff: { ...f.diff, staged } } : f
      )
    })),

  setClaudeSessionId: (id, claudeSessionId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, claudeSessionId } : s))
    })),

  addAgentSession: (agent, locationId) =>
    set((state) => {
      const sessionId = `agent-${locationId}-${agent.id}`
      if (state.sessions.some((s) => s.id === sessionId)) return {}
      const session: Session = {
        id: sessionId,
        cwd: agent.cwd ?? '',
        folderName: agent.name,
        name: agent.name,
        alive: agent.status !== 'offline',
        activityStatus:
          agent.status === 'busy' ? 'active' : agent.status === 'offline' ? 'ended' : 'idle',
        promptWaiting: null,
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        claudeAgentsMode: false,
        dangerousMode: false,
        claudeSessionId: null,
        locationId,
        sessionType: 'agent',
        agentId: agent.id,
        detectedUrl: null,
        serverStatus: null,
        serverCommand: null,
        hasUnseenActivity: false,
        userRenamed: false,
        planFilePath: null
      }
      return {
        sessions: [...state.sessions, session],
        displayOrder: [...getDisplayOrder(state), sessionId]
      }
    }),

  removeAgentSessions: (locationId) =>
    set((state) => {
      const agentSessionIds = new Set(
        state.sessions
          .filter((s) => s.sessionType === 'agent' && s.locationId === locationId)
          .map((s) => s.id)
      )
      if (agentSessionIds.size === 0) return {}
      return {
        sessions: state.sessions.filter((s) => !agentSessionIds.has(s.id)),
        displayOrder: getDisplayOrder(state).filter((id) => !agentSessionIds.has(id)),
        selectedSessionIds: state.selectedSessionIds.filter((id) => !agentSessionIds.has(id)),
        focusedSessionId: agentSessionIds.has(state.focusedSessionId ?? '')
          ? null
          : state.focusedSessionId
      }
    }),

  updateAgentSessionStatus: (agentId, locationId, status) =>
    set((state) => {
      const sessionId = `agent-${locationId}-${agentId}`
      const alive = status !== 'offline'
      const activityStatus: import('./session-types').ActivityStatus =
        status === 'busy' ? 'active' : status === 'offline' ? 'ended' : 'idle'
      return {
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, alive, activityStatus } : s
        )
      }
    }),

  isAgentInSidebar: (agentId, locationId) => {
    const state = useSessionStore.getState()
    return state.sessions.some((s) => s.id === `agent-${locationId}-${agentId}`)
  },

  hideAgentSession: (sessionId) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === sessionId)
      if (!session?.agentId || !session.locationId) return {}
      const compositeId = `${session.locationId}-${session.agentId}`
      const newHidden = new Set(state.hiddenAgentIds)
      newHidden.add(compositeId)
      localStorage.setItem('clave-hidden-agent-ids', JSON.stringify([...newHidden]))
      return {
        hiddenAgentIds: newHidden,
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        displayOrder: getDisplayOrder(state).filter((id) => id !== sessionId),
        selectedSessionIds: state.selectedSessionIds.filter((id) => id !== sessionId),
        focusedSessionId: state.focusedSessionId === sessionId ? null : state.focusedSessionId
      }
    })
}))

// Persist groups + sidebar ordering (via the main process) whenever either
// changes, so they survive an app restart. Sessions come back via tmux
// adoption; the saved layout is read on launch to rebuild the groups around the
// re-adopted sessions. Disabled until `enableSidebarPersistence()` runs so the
// empty initial state can't clobber the saved file before it's loaded.
useSessionStore.subscribe((state) => {
  if (!sidebarPersistEnabled) return
  if (state.groups !== lastPersistedGroups || state.displayOrder !== lastPersistedOrder) {
    persistSidebarLayout(state)
  }
})
