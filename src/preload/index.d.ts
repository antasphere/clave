import type { LinkedDocumentsAPI } from '../shared/linked-documents'
import type { ExtensionsInventory, MutationResult, MutationScope } from '../shared/extensions-types'
import type { WindowIdentity, Workspace, WorkspaceStateFile } from '../shared/workspace-types'
import type { DownloadProgress, ReleaseNote, UpdaterState } from '../shared/updater-types'
import type { GitRangeDirection } from '../shared/git-range'
import type {
  LaunchProfile,
  LaunchProfilePreferences,
  LauncherFamily,
  PiThinkingLevel
} from '../shared/agent-launch'

export type { DownloadProgress, ReleaseNote, UpdaterState, WindowIdentity }
export type { LaunchProfile, LaunchProfilePreferences, LauncherFamily, PiThinkingLevel }

/** Main's answer to `windowSetWorkspace`. Any window may show any workspace;
 *  only an unknown one is refused. */
export type SetWorkspaceResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-workspace' | 'no-window' }

/** Main's answer to a state write (layout, pins). */
export type WriteResult = { ok: true } | { ok: false; reason: 'invalid-key' | 'no-window' }

export interface HistoryLedgerRow {
  v: 1
  kind: 'placed' | 'closed'
  ts: string
  sessionId: string
  claudeSessionId: string | null
  name: string
  cwd: string
  mode: 'claude' | 'antigravity' | 'codex' | 'pi' | 'claude-agents' | 'terminal'
  model: string | null
  workspaceId: string | null
  groupId: string | null
  groupName: string | null
}

export type HistorySearchScope = 'human' | 'agent' | 'tools'

export interface HistorySearchHit {
  claudeSessionId: string
  ts: string | null
  scope: HistorySearchScope
  excerpt: string
}

export interface HistoryListEntry {
  source: 'ledger' | 'transcript'
  /** Which CLI's conversation this is; resume exists for claude only. */
  provider: 'claude' | 'codex' | 'pi' | 'antigravity'
  agentProvider?: string | null
  thinking?: PiThinkingLevel | null
  projectDir?: string
  claudeSessionId: string
  sessionId: string
  name: string
  cwd: string
  mode: HistoryLedgerRow['mode']
  model: string | null
  workspaceId: string | null
  groups: { id: string; name: string; firstAt: string }[]
  firstSeenAt: string
  lastSeenAt: string
  closedAt: string | null
  transcript: {
    exists: boolean
    path: string
    cwd: string | null
    firstAt: string | null
    title: string | null
    lastPrompt: string | null
    lastHumanAt: string | null
    modifiedAt: string | null
    sizeBytes: number
  }
  title: string
  lastHumanAt: string
}

/** One turn of a live tab's conversation, as the message trail shows it:
 *  the human message and the first line of the agent's final answer. */
export interface ConversationTurn {
  ts: string | null
  userText: string
  replyHead: string | null
}

/** What a window is told to take in: session ids to adopt (their records
 *  carry the rest) and, on a window close or a group move, groups. */
export interface RehomePayload {
  sessionIds: string[]
  layout: { groups: unknown[]; displayOrder: string[] } | null
  /** A deliberate move takes focus in its new window; a close hand-over does not. */
  focus: boolean
}

/** The outcome of moving sessions to another window. */
export interface MoveResult {
  moved: string[]
  refused: { sessionId: string; reason: 'not-live' | 'not-tmux' | 'same-window' }[]
}

/** Endpoint identity stamped on exchange-capture events; mirrors the
 *  contract's EndpointIdentity (src/main/exchange-capture/contract). `model`
 *  is additive (v2): the model the tab was opened with, null = the CLI's
 *  default. Clave never emits the contract's `gemini` mode. */
export interface ExchangeEndpoint {
  sessionId: string
  name: string
  mode: 'claude' | 'antigravity' | 'codex' | 'claude-agents' | 'terminal'
  cwd: string
  claudeSessionId: string | null
  groupId: string | null
  groupName: string | null
  model: string | null
}

export interface SecretRequestView {
  id: string
  callerSessionId?: string
  description: string
  action:
    | { type: 'run'; command: string; cwd: string; envVar: string }
    | { type: 'env-file'; file: string; key: string }
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dismissed' | 'expired'
  createdAt: number
  expiresAt: number
  outcome?: {
    ok: boolean
    exitCode?: number | null
    stdout?: string
    stderr?: string
    error?: string
    envFile?: { file: string; key: string; created: boolean }
  }
}

export interface CopyOfferView {
  id: string
  callerSessionId: string
  label: string
  preview: string
  truncated: boolean
  lineCount: number
  charCount: number
  sensitive: boolean
  createdAt: number
  copiedAt?: number
}

export interface ClaveFileGroupData {
  name: string
  cwd: string
  color: string | null
  toolbar?: boolean
  category?: string
  logo?: string
  /** Group-level default prompt: what sessions launched from the live group's
   *  `+` start on. Mirrors `ClaveGroupData.prompt` in the main process. */
  prompt?: string
  sessions: {
    cwd: string
    name: string
    claudeMode: boolean
    antigravityMode: boolean
    codexMode: boolean
    piMode?: boolean
    claudeAgentsMode?: boolean
    dangerousMode: boolean
    prompt?: string
    rootSession?: boolean
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
  }[]
}

export type ClaveFileReadResult =
  | ({ type: 'single' } & ClaveFileGroupData)
  | { type: 'multi'; groups: ClaveFileGroupData[] }

export interface ClaveFileWriteData {
  name?: string
  cwd?: string | null
  color?: string | null
  prompt?: string
  sessions?: {
    cwd: string
    name: string
    claudeMode: boolean
    antigravityMode: boolean
    codexMode: boolean
    piMode?: boolean
    claudeAgentsMode?: boolean
    dangerousMode: boolean
    prompt?: string
    rootSession?: boolean
  }[]
  terminals?: {
    command: string
    commandMode: 'prefill' | 'auto'
    color: string
    icon?: string
    cwd?: string | null
    autoLaunchLocalhost?: boolean
    persistent?: boolean
    serverUrl?: string
  }[]
  groups?: Array<{
    name: string
    cwd: string | null
    color: string | null
    toolbar?: boolean
    category?: string
    logo?: string
    prompt?: string
    sessions: {
      cwd: string
      name: string
      claudeMode: boolean
      antigravityMode: boolean
      codexMode: boolean
      piMode?: boolean
      claudeAgentsMode?: boolean
      dangerousMode: boolean
      prompt?: string
      rootSession?: boolean
    }[]
    terminals: {
      command: string
      commandMode: 'prefill' | 'auto'
      color: string
      icon?: string
      cwd?: string | null
      autoLaunchLocalhost?: boolean
      persistent?: boolean
      serverUrl?: string
    }[]
  }>
}

export interface SessionInfo {
  id: string
  cwd: string
  folderName: string
  alive: boolean
  claudeSessionId: string | null
  piSessionId: string | null
  launchProfileId?: string
  model?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
}

/** Who owns a session that is not a tab of its own — mirrors SessionLink in
 *  the main process. Absent on a record = an ordinary tab. */
export type SessionLink =
  | { kind: 'group-terminal'; groupId: string; terminalId: string }
  | { kind: 'session-view'; ownerId: string }
  | { kind: 'toolbar'; key: string }

export interface SessionRecord {
  /** Backing tmux session when there is one; absent = plain record (relaunch-only). */
  tmuxName?: string
  id: string
  claudeSessionId?: string
  piSessionId?: string
  cwd: string
  folderName: string
  /** Tab label the user last saw (rename or auto-title); absent → folderName. */
  displayName?: string
  /** True when displayName came from an explicit rename (blocks auto-titling). */
  userRenamed?: boolean
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  piMode: boolean
  claudeAgentsMode: boolean
  dangerousMode: boolean
  /** Model the session was launched on (claude/codex); re-applied on re-spawn. */
  model?: string
  launchProfileId?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
  configDir?: string
  claudeProfileId?: string
  claudeProfileLabel?: string
  /** Workspace this session belongs to (stamped at spawn, inferred from cwd
   *  for legacy records). Absent → unstamped; the renderer assigns active. */
  workspaceId?: string
  /** The window this session lives in (its persisted key). */
  windowKey?: string
  /** Attached web view behind the row's dashboard icon; restored at adoption.
   *  The serving session id never persists — the start action respawns it. */
  view?: { url: string; title?: string; command?: string; cwd?: string }
  /** What this session is the hidden half of (a group terminal, a session
   *  view's server, a toolbar button). Absent = a tab. The boot restore puts
   *  a linked session back where it belongs instead of in the sidebar. */
  link?: SessionLink
  /** True → reattach to a still-running tmux session. False → the tmux server
   *  died (reboot) but the sidecar survived; re-spawn fresh (Claude resumes). */
  live?: boolean
}

export interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

export interface FileStat {
  type: 'file' | 'directory'
  size: number
  modified: number
}

export interface FileReadResult {
  content: string
  truncated: boolean
  size: number
  binary: boolean
}

export interface UsageWindow {
  key: string
  label: string
  /** 'session' | 'weekly_all' | 'weekly_scoped' | whatever the service adds. */
  kind: string
  /** What a scoped cap is scoped to ('Fable', 'Opus'), else null. */
  scope: string | null
  usedPercentage: number
  resetsAt: number | null
  severity: 'normal' | 'warning' | 'critical' | null
}

export interface UsageLimits {
  windows: UsageWindow[]
  fetchedAt: number
  message?: string
}

/** A Claude account as the renderer sees it: never the token itself. */
export interface ClaudeAccount {
  id: string
  label: string
  /** Absolute `CLAUDE_CONFIG_DIR`, or '' for the shared `~/.claude`. */
  configDir: string
  hasToken: boolean
}

export interface PiUsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  sessions: number
  range: 'today' | '7d' | '30d' | 'all'
}

export interface UsageError {
  error: string
}

export interface GitFileStatus {
  path: string
  status:
    | 'staged'
    | 'modified'
    | 'deleted'
    | 'untracked'
    | 'staged-modified'
    | 'staged-deleted'
    | 'renamed'
  staged: boolean
}

/** The worktree reading of a checkout (PRDCT-2356); absent on a repo that is its own checkout. */
export interface GitWorktreeInfo {
  /** Absolute path of the main checkout this worktree belongs to. */
  of: string
  /** The ref the branch was cut from, or null when it cannot be named. */
  base: string | null
  /** `base` as the badge shows it, the remote prefix dropped. */
  baseLabel: string
  /** Commits the worktree has that the base does not. */
  ahead: number
  /** Commits the base gained that the worktree lacks. */
  behind: number
  /** The worktree's work is already in the base, by merge, fast-forward or squash. */
  merged: boolean
  /** When the branch was created (a detached checkout: the directory's birth), epoch ms, or null. */
  createdAt: number | null
  /** The head commit's moment (epoch ms) and subject. */
  lastCommit: { at: number; subject: string } | null
}

export interface GitStatusResult {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  hasUpstream: boolean
  files: GitFileStatus[]
  repoRoot: string
  worktree?: GitWorktreeInfo
}

export interface GitCommitResult {
  hash: string
  branch: string
}

export interface GitLogEntry {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  refs: string[]
}

export interface GitCommitFileStatus {
  path: string
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'
  insertions: number
  deletions: number
}

export interface GitPushGroup {
  id: string
  pushedAt: string
  commits: GitLogEntry[]
  summary?: {
    title: string
    description: string
  }
}

export interface GitJourneyResult {
  local: GitLogEntry[]
  pushGroups: GitPushGroup[]
  fallbackMode: boolean
  branch: string
  hasMore: boolean
}

export type {
  GitBatchOp,
  GitBatchPhase,
  GitBatchProgress,
  GitBatchProgressFn
} from '../shared/git-batch'
import type { GitBatchProgress } from '../shared/git-batch'

export interface MagicSyncResult {
  repoPath: string
  actions: string[]
  error: string | null
}

export interface MagicPullResult {
  repoPath: string
  pulled: boolean
  error: string | null
}

export interface ElectronAPI {
  /** `process.platform` of the main process. The renderer reads it only to
   *  decide whether to hold room for window buttons drawn inside our own
   *  chrome — macOS does, Windows and Linux do not. */
  platform: NodeJS.Platform

  launchProfilesList: () => Promise<LaunchProfilePreferences>
  launchProfileUpsert: (profile: LaunchProfile) => Promise<LaunchProfilePreferences>
  launchProfileDelete: (profileId: string) => Promise<LaunchProfilePreferences>
  launchProfileSetGlobal: (
    family: LauncherFamily,
    profileId: string | null
  ) => Promise<LaunchProfilePreferences>
  launchProfileSetWorkspace: (
    workspaceId: string,
    family: LauncherFamily,
    profileId: string | null
  ) => Promise<LaunchProfilePreferences>
  spawnSession: (
    cwd: string,
    options?: {
      dangerousMode?: boolean
      model?: string
      claudeMode?: boolean
      antigravityMode?: boolean
      codexMode?: boolean
      piMode?: boolean
      claudeAgentsMode?: boolean
      resumeSessionId?: string
      claudeSessionId?: string
      piSessionId?: string
      launchProfileId?: string
      piProvider?: string
      piThinking?: PiThinkingLevel
      initialCommand?: string
      autoExecute?: boolean
      initialPrompt?: string
      tmuxMode?: boolean
      adoptTmuxName?: string
      adoptSessionId?: string
      configDir?: string
      claudeProfileId?: string
      claudeProfileLabel?: string
      workspaceId?: string
      /** Spawning the hidden half of something else — persisted on the record
       *  so the next launch restores it as that half, not as a tab. */
      link?: SessionLink
    }
  ) => Promise<SessionInfo>
  writeSession: (id: string, data: string) => void
  startSession: (id: string, cols: number, rows: number) => void
  resizeSession: (id: string, cols: number, rows: number) => void
  killSession: (id: string) => Promise<void>
  listSessions: () => Promise<SessionInfo[]>
  setSessionDisplayName: (
    id: string,
    displayName: string | null,
    userRenamed: boolean
  ) => Promise<void>
  setSessionViewRecord: (
    id: string,
    view: { url: string; title?: string; command?: string; cwd?: string } | null
  ) => Promise<void>
  setSessionWorkspace: (id: string, workspaceId: string | null) => Promise<void>
  tmuxAvailable: () => Promise<boolean>
  listSessionRecords: (filter?: { ids?: string[] }) => Promise<SessionRecord[]>
  discardSessionRecord: (key: string) => Promise<void>
  onSessionRehome: (callback: (payload: RehomePayload) => void) => () => void
  onSessionRemovedForRehome: (callback: (sessionId: string) => void) => () => void
  onGroupRemovedForMove: (callback: (groupId: string) => void) => () => void
  ackRehomed: (sessionIds: string[]) => void
  onSessionData: (id: string, callback: (data: string) => void) => () => void
  onSessionExit: (id: string, callback: (exitCode: number) => void) => () => void
  onSessionAutoTitle: (sessionId: string, callback: (title: string) => void) => () => void
  onPlanDetected: (sessionId: string, callback: (planPath: string) => void) => () => void
  onClearDetected: (
    sessionId: string,
    callback: (newClaudeSessionId: string | null) => void
  ) => () => void
  onAgentState: (sessionId: string, callback: (state: string) => void) => () => void
  onMcpCommand: (
    callback: (msg: { requestId: string; command: string; payload: unknown }) => void
  ) => () => void
  mcpRespond: (response: {
    requestId: string
    ok: boolean
    result?: unknown
    error?: string
  }) => void
  captureExchangeMessage: (payload: {
    ts: string
    sender: ExchangeEndpoint
    target: ExchangeEndpoint
    text: string
    provenance: string
    delivered: boolean
  }) => void
  captureTabSpawn: (payload: {
    ts: string
    spawner: ExchangeEndpoint
    session: ExchangeEndpoint
    prompt: string | null
    model: string | null
  }) => void
  captureSessionState: (payload: {
    ts: string
    session: ExchangeEndpoint
    state: 'working' | 'idle' | 'blocked' | 'exited'
    previous: 'working' | 'idle' | 'blocked' | 'exited' | null
    source: 'hooks' | 'pty'
  }) => void
  captureTabClosed: (payload: {
    ts: string
    session: ExchangeEndpoint
    by: 'user' | 'agent' | 'app'
    closer: ExchangeEndpoint | null
  }) => void
  /** Session history (PRDCT-1738). A ledger row per placement change,
   *  fire-and-forget; the folded list for the dialog. */
  historyStamp: (row: HistoryLedgerRow) => void
  historyList: () => Promise<{ entries: HistoryListEntry[]; skippedLines: number }>
  /** The message trail's read: a live tab's conversation as turns. */
  historyConversation: (
    cwd: string,
    claudeSessionId: string,
    provider?: 'claude' | 'pi'
  ) => Promise<{ exists: boolean; turns: ConversationTurn[] }>
  /** Click-to-scroll: tmux-backed tabs are driven in main (`tmux: true`);
   *  plain ones answer `tmux: false` and the caller scans xterm's buffer. */
  scrollSessionToText: (
    id: string,
    needle: string,
    fromBottom: number
  ) => Promise<{ tmux: boolean }>
  /** A scoped substring search through the named sessions' transcripts;
   *  hits stream through `onHistorySearchHits`, the promise carries the end. */
  historySearch: (request: {
    requestId: string
    query: string
    scopes: HistorySearchScope[]
    claudeSessionIds: string[]
  }) => Promise<{ requestId: string; filesSearched: number; truncated: boolean }>
  historySearchCancel: (requestId: string) => void
  onHistorySearchHits: (
    callback: (progress: { requestId: string; hits: HistorySearchHit[] }) => void
  ) => () => void
  /** A `/clear` rotated the tab's transcript: the record follows the new id
   *  so a restart resumes the conversation the user is actually in. */
  setSessionClaudeSessionId: (id: string, claudeSessionId: string) => Promise<void>
  secretList: () => Promise<SecretRequestView[]>
  secretSubmit: (id: string, secret: string) => Promise<SecretRequestView>
  secretDismiss: (id: string) => Promise<SecretRequestView>
  onSecretRequestsChanged: (callback: (requests: SecretRequestView[]) => void) => () => void
  linkedDocuments: LinkedDocumentsAPI
  copyOfferList: () => Promise<CopyOfferView[]>
  copyOfferCopy: (id: string) => Promise<CopyOfferView>
  copyOfferDismiss: (id: string) => Promise<void>
  copyOfferDismissSession: (sessionId: string) => Promise<void>
  onCopyOffersChanged: (callback: (offers: CopyOfferView[]) => void) => () => void
  saveDiscussion: (
    cwd: string,
    claudeSessionId: string,
    sessionName: string,
    extras?: { sessionType?: string | null; locationId?: string | null }
  ) => Promise<{ success: boolean; error?: string }>
  savePlan: (
    cwd: string,
    claudeSessionId: string,
    sessionName: string,
    extras?: { sessionType?: string | null; locationId?: string | null }
  ) => Promise<{ success: boolean; error?: string }>
  openExternal: (url: string) => Promise<void>
  checkPort: (port: number) => Promise<boolean>
  /** HTTP liveness probe (any HTTP response = true). Stricter than checkPort:
   *  proves a server answers, not just that something bound the port. */
  probeServerUrl: (url: string, timeoutMs?: number) => Promise<boolean>
  openPath: (filePath: string) => Promise<string>
  /** Register an HTML file with the clave-preview protocol; returns the URL an
   *  in-app preview iframe loads it from (assets scoped to the file's directory). */
  registerHtmlPreview: (filePath: string) => Promise<{ url: string }>
  openFolderDialog: (defaultPath?: string) => Promise<string | null>
  onUpdateAvailable: (callback: (version: string) => void) => () => void
  onUpdateDownloaded: (callback: (version: string) => void) => () => void
  onDownloadProgress: (callback: (progress: DownloadProgress) => void) => () => void
  onDownloadError: (callback: (message: string) => void) => () => void
  onUpdaterState: (callback: (state: UpdaterState) => void) => () => void
  onOpenSettingsSection: (callback: (section: string) => void) => () => void
  onMissionControlEntered: (callback: () => void) => () => void
  onMissionControlExited: (callback: () => void) => () => void
  missionControlGetEnabled: () => Promise<boolean>
  missionControlSetEnabled: (enabled: boolean) => Promise<void>
  setAppIcon: (icon: string) => Promise<void>
  /** A trackpad haptic (macOS Force Touch); fire-and-forget, no-op elsewhere. */
  hapticTick: (pattern?: 'alignment' | 'generic' | 'level') => void
  getUsername: () => Promise<string | null>
  getAppVersion: () => Promise<string>
  installUpdate: () => Promise<void>
  startDownload: (attempt?: 'first' | 'retry') => Promise<void>
  openUpdaterLog: () => Promise<string>
  openReleasesPage: () => Promise<void>
  cancelDownload: () => Promise<void>
  getUpdaterState: () => Promise<UpdaterState>
  checkForUpdates: () => Promise<UpdaterState>
  /** "Receive pre-release builds": persisted, applied, and a check run at once. */
  setPrereleaseUpdates: (enabled: boolean) => Promise<UpdaterState>
  getPathForFile: (file: File) => string
  persistDroppedFile: (sourcePath: string) => Promise<string | null>
  showNotification: (options: {
    title: string
    body: string
    sessionId: string
  }) => Promise<'shown' | 'skipped-focused' | 'unsupported'>
  onNotificationClicked: (callback: (sessionId: string) => void) => () => void
  listFiles: (cwd: string) => Promise<{ files: string[]; truncated: boolean }>
  readDir: (rootCwd: string, dirPath: string) => Promise<DirEntry[]>
  existsSync: (rootCwd: string, relPath: string) => boolean
  readFile: (rootCwd: string, filePath: string) => Promise<FileReadResult>
  statFile: (rootCwd: string, filePath: string) => Promise<FileStat>
  writeFile: (rootCwd: string, filePath: string, content: string) => Promise<void>
  createFile: (rootCwd: string, filePath: string) => Promise<void>
  createDirectory: (rootCwd: string, dirPath: string) => Promise<void>
  showItemInFolder: (fullPath: string) => Promise<void>
  watchDir: (cwd: string, dirs?: string[]) => Promise<void>
  unwatchDir: () => Promise<void>
  onFsChanged: (callback: (cwd: string, changedDirs: string[]) => void) => () => void
  sidebarLayoutLoad: () => Promise<{ groups: unknown[]; displayOrder: string[] }>
  sidebarLayoutSave: (data: { groups: unknown[]; displayOrder: string[] }) => Promise<WriteResult>
  workspaceLoad: () => Promise<WorkspaceStateFile>
  workspaceUpdateRegistry: (
    workspaces: Workspace[]
  ) => Promise<{ ok: true } | { ok: false; reason: 'invalid' }>
  workspaceUpdatePins: (scope: string | null | 'all', pins: unknown[]) => Promise<WriteResult>
  workspaceSetLastActive: (workspaceId: string | null) => Promise<{ ok: true }>
  onWorkspaceStateChanged: (
    callback: (state: { workspaces: Workspace[]; pins: unknown[] }) => void
  ) => () => void
  windowIdentity: () => Promise<WindowIdentity | null>
  onWindowIdentityChanged: (callback: (identity: WindowIdentity) => void) => () => void
  windowIsFullScreen: () => Promise<boolean>
  onWindowFullScreenChanged: (callback: (fullScreen: boolean) => void) => () => void
  windowSetWorkspace: (workspaceId: string | null) => Promise<SetWorkspaceResult>
  windowList: () => Promise<WindowIdentity[]>
  windowOpen: (workspaceId?: string) => Promise<{ windowId: number }>
  windowMoveSessions: (sessionIds: string[], targetWindowId: number) => Promise<MoveResult>
  windowMoveGroup: (group: unknown, targetWindowId: number) => Promise<MoveResult & { ok: boolean }>
  getUsageLimits: (
    accountId?: string,
    options?: { force?: boolean }
  ) => Promise<UsageLimits | UsageError>
  getClaudeUsageSnapshot: () => Promise<Record<string, UsageLimits | UsageError>>
  onClaudeAccountUsage: (
    callback: (update: { accountId: string; result: UsageLimits | UsageError }) => void
  ) => () => void
  claudeAccountsList: () => Promise<ClaudeAccount[]>
  claudeAccountAdd: (input: { label: string; configDir?: string }) => Promise<ClaudeAccount>
  claudeAccountUpdate: (
    id: string,
    updates: { label?: string; configDir?: string }
  ) => Promise<ClaudeAccount | undefined>
  claudeAccountRemove: (id: string) => Promise<boolean>
  /** Stores the token and reads the account's limits with it in one call. */
  claudeAccountSetToken: (id: string, token: string) => Promise<UsageLimits | UsageError>
  claudeAccountClearToken: (id: string) => Promise<void>
  onClaudeAccountsChanged: (callback: (accounts: ClaudeAccount[]) => void) => () => void
  getCodexUsageLimits: () => Promise<UsageLimits | UsageError>
  getPiUsage: (range: PiUsageTotals['range']) => Promise<PiUsageTotals>
  gitCheckIgnored: (cwd: string, paths: string[]) => Promise<string[]>
  getGitStatus: (cwd: string) => Promise<GitStatusResult>
  getGitStatusBatch: (paths: string[]) => Promise<Array<{ path: string; status: GitStatusResult }>>
  gitFetch: (cwd: string) => Promise<void>
  gitFetchBatch: (paths: string[]) => Promise<void>
  discoverGitRepos: (
    cwd: string,
    force?: boolean
  ) => Promise<{ repos: Array<{ name: string; path: string }>; truncated: boolean }>
  gitStage: (cwd: string, files: string[]) => Promise<void>
  gitUnstage: (cwd: string, files: string[]) => Promise<void>
  gitCommit: (cwd: string, message: string) => Promise<GitCommitResult>
  gitPush: (cwd: string) => Promise<void>
  gitPublishBranch: (cwd: string) => Promise<void>
  gitPull: (cwd: string, strategy?: 'auto' | 'merge' | 'rebase' | 'ff-only') => Promise<void>
  gitDiscard: (
    cwd: string,
    files: Array<{ path: string; status: string; staged: boolean }>
  ) => Promise<void>
  gitDiff: (cwd: string, filePath: string, staged: boolean, isUntracked: boolean) => Promise<string>
  gitLog: (cwd: string, maxCount?: number) => Promise<GitLogEntry[]>
  gitOutgoingCommits: (cwd: string) => Promise<GitLogEntry[]>
  gitIncomingCommits: (cwd: string) => Promise<GitLogEntry[]>
  gitRangeFiles: (cwd: string, direction: GitRangeDirection) => Promise<GitCommitFileStatus[]>
  gitRangeDiff: (cwd: string, direction: GitRangeDirection, filePath: string) => Promise<string>
  gitCommitFiles: (cwd: string, hash: string) => Promise<GitCommitFileStatus[]>
  gitCommitDiff: (cwd: string, hash: string, filePath: string) => Promise<string>
  gitGenerateCommitMessage: (cwd: string) => Promise<string>
  gitMagicSync: (repoPaths: string[]) => Promise<MagicSyncResult[]>
  gitMagicPull: (repoPaths: string[]) => Promise<MagicPullResult[]>
  /** The discovery sweep: fetch every listed repo, so the ↓ badges are true. */
  gitRefreshRemotes: (
    repoPaths: string[]
  ) => Promise<Array<{ repoPath: string; error: string | null }>>
  /** Progress for BOTH batch ops — the payload's `op` says which. */
  onGitBatchProgress: (callback: (progress: GitBatchProgress) => void) => () => void
  gitJourney: (cwd: string, maxCount?: number) => Promise<GitJourneyResult>
  gitSummarizePush: (
    cwd: string,
    commitMessages: string[],
    diffStats: string
  ) => Promise<{ title: string; description: string }>

  // Locations
  locationList: () => Promise<import('../shared/remote-types').Location[]>
  locationAdd: (
    loc: unknown,
    password?: string
  ) => Promise<import('../shared/remote-types').Location>
  locationUpdate: (id: string, updates: unknown) => Promise<void>
  locationRemove: (id: string) => Promise<void>
  locationTestConnection: (id: string) => Promise<{
    success: boolean
    error?: string
    openclawVersion?: string
    openclawPort?: number
    openclawToken?: string
  }>
  locationInstallPlugin: (
    id: string
  ) => Promise<{ success: boolean; output?: string; error?: string }>

  // SSH / Remote Terminal
  sshConnect: (locationId: string) => Promise<void>
  sshDisconnect: (locationId: string) => Promise<void>
  sshExec: (
    locationId: string,
    command: string
  ) => Promise<{ stdout: string; stderr: string; code: number }>
  sshOpenShell: (locationId: string, cwd?: string) => Promise<string>
  sshShellWrite: (shellId: string, data: string) => void
  sshShellResize: (shellId: string, cols: number, rows: number) => void
  sshShellClose: (shellId: string) => Promise<void>
  onSshShellData: (shellId: string, callback: (data: string) => void) => () => void
  onSshShellExit: (shellId: string, callback: (exitCode: number) => void) => () => void
  onSshConnectionClosed: (callback: (locationId: string) => void) => () => void

  // Remote FS (SFTP)
  sftpReadDir: (
    locationId: string,
    dirPath: string
  ) => Promise<import('../shared/remote-types').RemoteDirEntry[]>
  sftpReadFile: (locationId: string, filePath: string) => Promise<string>
  sftpStat: (
    locationId: string,
    filePath: string
  ) => Promise<{ isDirectory: boolean; isFile: boolean; size: number; mtime: number }>

  // Agents
  agentList: (locationId: string) => Promise<import('../shared/remote-types').Agent[]>
  agentConnect: (locationId: string) => Promise<void>
  agentDisconnect: (locationId: string) => Promise<void>
  agentSessions: (locationId: string) => Promise<unknown>
  agentChatHistory: (locationId: string, sessionKey: string) => Promise<unknown>
  agentSend: (
    agentId: string,
    locationId: string,
    content: string
  ) => Promise<import('../shared/remote-types').ChatMessage>
  onAgentMessage: (agentId: string, callback: (message: unknown) => void) => () => void
  onAgentsUpdated: (callback: (locationId: string, agents: unknown[]) => void) => () => void

  // .clave files
  readClaveFile: (absolutePath: string, rootDir?: string) => Promise<ClaveFileReadResult | null>
  writeClaveFile: (
    absolutePath: string,
    data: ClaveFileWriteData,
    rootDir?: string
  ) => Promise<void>
  watchClaveFile: (absolutePath: string) => Promise<void>
  unwatchClaveFile: (absolutePath: string) => Promise<void>
  onClaveFileChanged: (callback: (filePath: string) => void) => () => void
  saveFileDialog: (
    defaultName: string,
    filters: { name: string; extensions: string[] }[]
  ) => Promise<string | null>
  getDownloadsPath: () => Promise<string>
  getUserDataPath: () => Promise<string>
  claveFileExists: (absolutePath: string) => Promise<boolean>
  discoverClaveFiles: (
    folderPath: string
  ) => Promise<{ name: string; path: string; rootDir: string | null }[]>
  discoverClaveFilesRecursive: (
    rootDir: string,
    config?: { patterns?: string[]; exclude?: string[]; maxDepth?: number; workspaceId?: string }
  ) => Promise<{ name: string; path: string; rootDir: string }[]>
  readAutoDiscoverConfig: (filePath: string) => Promise<{
    enabled: boolean
    patterns?: string[]
    exclude?: string[]
    maxDepth?: number
  } | null>
  readImageAsDataUrl: (absolutePath: string) => Promise<string | null>
  preferencesGet: (key: string) => Promise<unknown>
  preferencesSet: (key: string, value: unknown) => Promise<void>
  keymapsLoad: () => Promise<unknown>
  keymapsSave: (value: unknown) => Promise<unknown>
  keymapsImport: () => Promise<string | null>
  keymapsExport: (json: string) => Promise<boolean>
  onKeymapsChanged: (callback: (value: unknown) => void) => () => void
  trustWorkspaceRoot: (root: string) => Promise<void>
  untrustWorkspaceRoot: (root: string) => Promise<void>
  listTrustedRoots: () => Promise<string[]>
  extensionsGetInventory: (configDir?: string) => Promise<ExtensionsInventory>
  extensionsInstallPlugin: (
    pluginId: string,
    scope: MutationScope,
    configDir?: string
  ) => Promise<MutationResult>
  extensionsUninstallPlugin: (
    pluginId: string,
    scope: MutationScope,
    configDir?: string
  ) => Promise<MutationResult>
  extensionsSetPluginEnabled: (
    pluginId: string,
    enabled: boolean,
    scope: MutationScope,
    configDir?: string
  ) => Promise<MutationResult>
  extensionsAddMarketplace: (source: string, configDir?: string) => Promise<MutationResult>
  extensionsRemoveMarketplace: (name: string, configDir?: string) => Promise<MutationResult>
  telemetryGetState: () => Promise<{
    enabled: boolean
    installId: string | null
    lastPingAt: string | null
    noticeShown: boolean
  }>
  telemetrySetEnabled: (enabled: boolean) => Promise<void>
  telemetrySetNoticeShown: () => Promise<void>
  feedbackGetState: () => Promise<{ collapsed: boolean }>
  feedbackSetCollapsed: () => Promise<void>
  feedbackSubmit: (submission: {
    email: string
    message?: string
  }) => Promise<{ ok: true } | { ok: false; error: string }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
