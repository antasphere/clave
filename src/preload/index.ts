import type { Session, SessionStream, UserMessage } from '../shared/session-model'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdaterState } from '../shared/updater-types'
import type { LaunchProfile, LauncherFamily } from '../shared/agent-launch'
import type { GitBatchProgress } from '../shared/git-batch'
import type { GitRangeDirection } from '../shared/git-range'

/** Creates a typed IPC event listener with cleanup function. */
function createIpcListener<T extends unknown[]>(
  channel: string,
  callback: (...args: T) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: T): void => callback(...args)
  ipcRenderer.on(channel, listener)
  return (): void => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// One main-process subscription per renderer/session; each view owns a ref.
const sessionSubscriptionRefs = new Map<string, number>()

const electronAPI = {
  sessionsList: (): Promise<Session[]> => ipcRenderer.invoke('sessions:list'),
  sessionsSubscribe: async (id: string): Promise<Session> => {
    sessionSubscriptionRefs.set(id, (sessionSubscriptionRefs.get(id) ?? 0) + 1)
    try {
      return await ipcRenderer.invoke('sessions:subscribe', id)
    } catch (error) {
      const refs = (sessionSubscriptionRefs.get(id) ?? 1) - 1
      if (refs > 0) sessionSubscriptionRefs.set(id, refs)
      else sessionSubscriptionRefs.delete(id)
      throw error
    }
  },
  sessionsUnsubscribe: (id: string): Promise<void> => {
    const refs = sessionSubscriptionRefs.get(id) ?? 0
    if (refs > 1) {
      sessionSubscriptionRefs.set(id, refs - 1)
      return Promise.resolve()
    }
    sessionSubscriptionRefs.delete(id)
    return ipcRenderer.invoke('sessions:unsubscribe', id)
  },
  sessionsWrite: (id: string, input: Uint8Array | UserMessage): Promise<void> =>
    ipcRenderer.invoke('sessions:write', id, input),
  onSessionStream: (id: string, callback: (stream: SessionStream) => void) =>
    createIpcListener(`sessions:stream:${id}`, callback),
  onSessionStreamExit: (id: string, callback: (code: number) => void) =>
    createIpcListener(`sessions:exit:${id}`, callback),

  /** Which OS the window is on. The renderer needs it for exactly one class of
   *  decision: chrome that holds room for the platform's own window buttons.
   *  Only macOS puts them INSIDE our chrome (`titleBarStyle: 'hiddenInset'`,
   *  src/main/index.ts); Windows and Linux keep a native frame and draw them
   *  above it, so clearance held on those platforms is a hole. Sync, not an
   *  invoke: it is a constant for the life of the process and chrome laid out
   *  after a round-trip would jump on first paint. */
  platform: process.platform,

  launchProfilesList: () => ipcRenderer.invoke('launch-profiles:list'),
  launchProfileUpsert: (profile: LaunchProfile) =>
    ipcRenderer.invoke('launch-profiles:upsert', profile),
  launchProfileDelete: (profileId: string) =>
    ipcRenderer.invoke('launch-profiles:delete', profileId),
  launchProfileSetGlobal: (family: LauncherFamily, profileId: string | null) =>
    ipcRenderer.invoke('launch-profiles:set-global', { family, profileId }),
  launchProfileSetWorkspace: (
    workspaceId: string,
    family: LauncherFamily,
    profileId: string | null
  ) => ipcRenderer.invoke('launch-profiles:set-workspace', { workspaceId, family, profileId }),
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
      piThinking?: import('../shared/agent-launch').PiThinkingLevel
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
      link?:
        | { kind: 'group-terminal'; groupId: string; terminalId: string }
        | { kind: 'session-view'; ownerId: string }
        | { kind: 'toolbar'; key: string }
    }
  ) => ipcRenderer.invoke('pty:spawn', cwd, options),

  writeSession: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),

  startSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:start', id, cols, rows),

  resizeSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),

  killSession: (id: string) => ipcRenderer.invoke('pty:kill', id),

  listSessions: () => ipcRenderer.invoke('pty:list'),

  setSessionDisplayName: (id: string, displayName: string | null, userRenamed: boolean) =>
    ipcRenderer.invoke('session:set-display-name', id, displayName, userRenamed),
  setSessionViewRecord: (
    id: string,
    view: { url: string; title?: string; command?: string; cwd?: string } | null
  ) => ipcRenderer.invoke('session:set-view', id, view),

  setSessionWorkspace: (id: string, workspaceId: string | null) =>
    ipcRenderer.invoke('session:set-workspace', id, workspaceId),

  tmuxAvailable: () => ipcRenderer.invoke('tmux:available'),

  // This window's own records (plus the orphans, for the primary); `ids`
  // fetches specific records whatever their window (the re-home path).
  listSessionRecords: (filter?: { ids?: string[] }) =>
    ipcRenderer.invoke('records:list-adoptable', filter),

  discardSessionRecord: (key: string) => ipcRenderer.invoke('records:discard', key),

  // Sessions handed to this window to take in — a closing window's (with its
  // groups), or tabs moved here — as ids; the records carry the rest.
  onSessionRehome: (
    callback: (payload: { sessionIds: string[]; layout: unknown | null; focus: boolean }) => void
  ) =>
    createIpcListener<[{ sessionIds: string[]; layout: unknown | null; focus: boolean }]>(
      'session:rehome',
      callback
    ),
  // A session this window held just MOVED to another window: drop the tab
  // without touching the pty.
  onSessionRemovedForRehome: (callback: (sessionId: string) => void) =>
    createIpcListener<[string]>('session:removed-for-rehome', callback),
  // A group this window held just MOVED whole to another window: drop it
  // here without touching any pty.
  onGroupRemovedForMove: (callback: (groupId: string) => void) =>
    createIpcListener<[string]>('group:removed-for-move', callback),
  // Acknowledge a `session:rehome` once adopted (a cross-window MCP move
  // waits on it before placing the tab in a group here).
  ackRehomed: (sessionIds: string[]) => ipcRenderer.send('window:rehomed', sessionIds),

  onSessionData: (id: string, callback: (data: string) => void) =>
    createIpcListener<[string]>(`pty:data:${id}`, callback),

  onSessionExit: (id: string, callback: (exitCode: number) => void) =>
    createIpcListener<[number]>(`pty:exit:${id}`, callback),

  onSessionAutoTitle: (sessionId: string, callback: (title: string) => void) =>
    createIpcListener<[string]>(`session:auto-title:${sessionId}`, callback),

  onPlanDetected: (sessionId: string, callback: (planPath: string) => void) =>
    createIpcListener<[string]>(`session:plan-detected:${sessionId}`, callback),

  onClearDetected: (sessionId: string, callback: (newClaudeSessionId: string | null) => void) =>
    createIpcListener<[string | null]>(`session:clear-detected:${sessionId}`, callback),

  onAgentState: (sessionId: string, callback: (state: string) => void) =>
    createIpcListener<[string]>(`agent:state:${sessionId}`, callback),

  onMcpCommand: (
    callback: (msg: { requestId: string; command: string; payload: unknown }) => void
  ) =>
    createIpcListener<[{ requestId: string; command: string; payload: unknown }]>(
      'mcp:command',
      callback
    ),

  mcpRespond: (response: { requestId: string; ok: boolean; result?: unknown; error?: string }) =>
    ipcRenderer.send('mcp:response', response),

  // Exchange capture: fire-and-forget observability writes — the renderer
  // never waits on these, so a capture failure can't delay a delivery.
  captureExchangeMessage: (payload: {
    ts: string
    sender: unknown
    target: unknown
    text: string
    provenance: string
    delivered: boolean
  }) => ipcRenderer.send('exchange:capture-message', payload),

  captureTabSpawn: (payload: {
    ts: string
    spawner: unknown
    session: unknown
    prompt: string | null
    model: string | null
  }) => ipcRenderer.send('exchange:capture-tab-spawn', payload),

  captureSessionState: (payload: {
    ts: string
    session: unknown
    state: string
    previous: string | null
    source: string
  }) => ipcRenderer.send('exchange:capture-session-state', payload),

  captureTabClosed: (payload: { ts: string; session: unknown; by: string; closer: unknown }) =>
    ipcRenderer.send('exchange:capture-tab-closed', payload),

  // Session history (PRDCT-1738): the ledger row is fire-and-forget like the
  // capture above; the list is the dialog's one read.
  historyStamp: (row: unknown) => ipcRenderer.send('history:stamp', row),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyConversation: (cwd: string, claudeSessionId: string, provider?: 'claude' | 'pi') =>
    ipcRenderer.invoke('history:conversation', { cwd, claudeSessionId, provider }),
  scrollSessionToText: (id: string, needle: string, fromBottom: number) =>
    ipcRenderer.invoke('session:scroll-to-text', id, needle, fromBottom),
  historySearch: (request: {
    requestId: string
    query: string
    scopes: string[]
    claudeSessionIds: string[]
  }) => ipcRenderer.invoke('history:search', request),
  historySearchCancel: (requestId: string) => ipcRenderer.send('history:search-cancel', requestId),
  onHistorySearchHits: (callback: (progress: { requestId: string; hits: unknown[] }) => void) =>
    createIpcListener<[{ requestId: string; hits: unknown[] }]>('history:search-hits', callback),
  setSessionClaudeSessionId: (id: string, claudeSessionId: string) =>
    ipcRenderer.invoke('session:set-claude-session-id', id, claudeSessionId),

  secretList: () => ipcRenderer.invoke('secret:list'),

  secretSubmit: (id: string, secret: string) => ipcRenderer.invoke('secret:submit', id, secret),

  secretDismiss: (id: string) => ipcRenderer.invoke('secret:dismiss', id),

  onSecretRequestsChanged: (callback: (requests: unknown[]) => void) =>
    createIpcListener<[unknown[]]>('secret:requests-changed', callback),

  linkedDocuments: {
    getDefaultSignature: () => ipcRenderer.invoke('linked-documents:get-default-signature'),
    setDefaultSignature: (path: string) =>
      ipcRenderer.invoke('linked-documents:set-default-signature', path),
    list: () => ipcRenderer.invoke('linked-documents:list'),
    open: (sessionId: string, input: unknown) =>
      ipcRenderer.invoke('linked-documents:open', sessionId, input),
    update: (id: string, revision: number, input: unknown) =>
      ipcRenderer.invoke('linked-documents:update', id, revision, input),
    openAttachment: (id: string, attachmentId: string) =>
      ipcRenderer.invoke('linked-documents:open-attachment', id, attachmentId),
    chooseFiles: (signature?: boolean) =>
      ipcRenderer.invoke('linked-documents:choose-files', signature),
    onChanged: (callback: () => void) => createIpcListener<[]>('linked-documents:changed', callback)
  },
  copyOfferList: () => ipcRenderer.invoke('copy-offer:list'),

  copyOfferCopy: (id: string) => ipcRenderer.invoke('copy-offer:copy', id),

  copyOfferDismiss: (id: string) => ipcRenderer.invoke('copy-offer:dismiss', id),

  copyOfferDismissSession: (sessionId: string) =>
    ipcRenderer.invoke('copy-offer:dismiss-session', sessionId),

  onCopyOffersChanged: (callback: (offers: unknown[]) => void) =>
    createIpcListener<[unknown[]]>('copy-offer:changed', callback),

  saveDiscussion: (
    cwd: string,
    claudeSessionId: string,
    sessionName: string,
    extras?: { sessionType?: string | null; locationId?: string | null }
  ) => ipcRenderer.invoke('session:save-discussion', cwd, claudeSessionId, sessionName, extras),

  savePlan: (
    cwd: string,
    claudeSessionId: string,
    sessionName: string,
    extras?: { sessionType?: string | null; locationId?: string | null }
  ) => ipcRenderer.invoke('session:save-plan', cwd, claudeSessionId, sessionName, extras),

  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  checkPort: (port: number) => ipcRenderer.invoke('net:check-port', port) as Promise<boolean>,
  probeServerUrl: (url: string, timeoutMs?: number) =>
    ipcRenderer.invoke('net:probe-url', url, timeoutMs) as Promise<boolean>,

  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),

  registerHtmlPreview: (filePath: string) =>
    ipcRenderer.invoke('preview:register', filePath) as Promise<{ url: string }>,

  openFolderDialog: (defaultPath?: string) => ipcRenderer.invoke('dialog:openFolder', defaultPath),

  onUpdateAvailable: (callback: (version: string) => void) =>
    createIpcListener<[string]>('updater:update-available', callback),

  onUpdateDownloaded: (callback: (version: string) => void) =>
    createIpcListener<[string]>('updater:update-downloaded', callback),

  onDownloadProgress: (
    callback: (progress: {
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }) => void
  ) =>
    createIpcListener<
      [{ percent: number; bytesPerSecond: number; transferred: number; total: number }]
    >('updater:download-progress', callback),

  onDownloadError: (callback: (message: string) => void) =>
    createIpcListener<[string]>('updater:download-error', callback),

  onUpdaterState: (callback: (state: UpdaterState) => void) =>
    createIpcListener<[UpdaterState]>('updater:state', callback),

  onOpenSettingsSection: (callback: (section: string) => void) =>
    createIpcListener<[string]>('menu:open-settings-section', callback),

  onMissionControlEntered: (callback: () => void) =>
    createIpcListener<[]>('mission-control:entered', callback),
  onMissionControlExited: (callback: () => void) =>
    createIpcListener<[]>('mission-control:exited', callback),
  missionControlGetEnabled: () =>
    ipcRenderer.invoke('mission-control:get-enabled') as Promise<boolean>,
  missionControlSetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('mission-control:set-enabled', enabled),

  setAppIcon: (icon: string) => ipcRenderer.invoke('app:set-icon', icon),
  hapticTick: (pattern?: 'alignment' | 'generic' | 'level') =>
    ipcRenderer.send('haptic:tick', pattern ?? 'alignment'),
  getUsername: () => ipcRenderer.invoke('app:get-username') as Promise<string | null>,
  saveAvatar: (sourcePath: string) =>
    ipcRenderer.invoke('app:save-avatar', sourcePath) as Promise<string | null>,
  getAppVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,

  installUpdate: () => ipcRenderer.invoke('updater:install'),
  startDownload: (attempt?: 'first' | 'retry') =>
    ipcRenderer.invoke('updater:start-download', attempt),
  openUpdaterLog: () => ipcRenderer.invoke('updater:open-log'),
  openReleasesPage: () => ipcRenderer.invoke('updater:open-releases'),
  cancelDownload: () => ipcRenderer.invoke('updater:cancel-download'),
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state') as Promise<UpdaterState>,
  checkForUpdates: () => ipcRenderer.invoke('updater:check') as Promise<UpdaterState>,

  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  persistDroppedFile: (sourcePath: string) =>
    ipcRenderer.invoke('files:persist-dropped', sourcePath) as Promise<string | null>,

  // File system
  listFiles: (cwd: string) => ipcRenderer.invoke('fs:list-files', cwd),
  readDir: (rootCwd: string, dirPath: string) =>
    ipcRenderer.invoke('fs:read-dir', rootCwd, dirPath),
  existsSync: (rootCwd: string, relPath: string): boolean =>
    ipcRenderer.sendSync('fs:exists-sync', rootCwd, relPath),
  readFile: (rootCwd: string, filePath: string) =>
    ipcRenderer.invoke('fs:read-file', rootCwd, filePath),
  statFile: (rootCwd: string, filePath: string) => ipcRenderer.invoke('fs:stat', rootCwd, filePath),
  writeFile: (rootCwd: string, filePath: string, content: string) =>
    ipcRenderer.invoke('fs:write-file', rootCwd, filePath, content),
  createFile: (rootCwd: string, filePath: string) =>
    ipcRenderer.invoke('fs:create-file', rootCwd, filePath),
  createDirectory: (rootCwd: string, dirPath: string) =>
    ipcRenderer.invoke('fs:create-directory', rootCwd, dirPath),
  showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath),

  // File system watching
  watchDir: (cwd: string, dirs?: string[]) => ipcRenderer.invoke('fs:watch', cwd, dirs ?? []),
  unwatchDir: () => ipcRenderer.invoke('fs:unwatch'),
  onFsChanged: (callback: (cwd: string, changedDirs: string[]) => void) =>
    createIpcListener<[string, string[]]>('fs:changed', callback),

  // Sidebar layout (session groups + display order), ONE FILE PER WINDOW —
  // main-process JSON storage so the groups survive a hard kill that drops
  // Chromium's lazily-flushed localStorage. A window reads and writes its own
  // file only (main resolves it from the sender); the primary's load also
  // takes in the orphans of windows that no longer exist.
  sidebarLayoutLoad: () => ipcRenderer.invoke('sidebar-layout:load'),
  sidebarLayoutSave: (data: { groups: unknown[]; displayOrder: string[] }) =>
    ipcRenderer.invoke('sidebar-layout:save', data),

  // Workspace registry + pins — main-process JSON storage, same crash-safety
  // rationale as the sidebar layouts, written FIELD BY FIELD: several windows
  // share the file, and a whole-file save was last-writer-wins.
  workspaceLoad: () => ipcRenderer.invoke('workspace:load'),
  workspaceUpdateRegistry: (workspaces: unknown[]) =>
    ipcRenderer.invoke('workspace:update-registry', workspaces),
  workspaceUpdatePins: (scope: string | null | 'all', pins: unknown[]) =>
    ipcRenderer.invoke('workspace:update-pins', scope, pins),
  workspaceSetLastActive: (workspaceId: string | null) =>
    ipcRenderer.invoke('workspace:set-last-active', workspaceId),
  onWorkspaceStateChanged: (
    callback: (state: { workspaces: unknown[]; pins: unknown[] }) => void
  ) =>
    createIpcListener<[{ workspaces: unknown[]; pins: unknown[] }]>(
      'workspace:state-changed',
      callback
    ),

  // This window's identity — its id, its persisted key, the workspace it
  // shows, whether it is the primary. A renderer only ever learns its own;
  // pushed again when the primary is re-elected.
  windowIdentity: () => ipcRenderer.invoke('window:identity'),
  onWindowIdentityChanged: (callback: (identity: unknown) => void) =>
    createIpcListener<[unknown]>('window:identity-changed', callback),
  // Tell main this window now shows a workspace (persisted; the next spawn
  // stamps against it). Any window may show any workspace.
  windowSetWorkspace: (workspaceId: string | null) =>
    ipcRenderer.invoke('window:set-workspace', workspaceId),
  // Whether THIS window is fullscreen — macOS hides the traffic lights there,
  // so the chrome that keeps clear of them closes the gap.
  windowIsFullScreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  onWindowFullScreenChanged: (callback: (fullScreen: boolean) => void) =>
    createIpcListener<[boolean]>('window:fullscreen-changed', callback),
  // Every open window, for the "move to window" pickers.
  windowList: () => ipcRenderer.invoke('window:list'),
  // A new window — the app once more — on a workspace (default: this one's).
  windowOpen: (workspaceId?: string) => ipcRenderer.invoke('window:open', workspaceId),
  // Move live tabs (tmux-backed) to another window, id and scrollback kept.
  windowMoveSessions: (sessionIds: string[], targetWindowId: number) =>
    ipcRenderer.invoke('window:move-sessions', sessionIds, targetWindowId),
  // Move a whole group (its object + its live members) to another window.
  windowMoveGroup: (group: unknown, targetWindowId: number) =>
    ipcRenderer.invoke('window:move-group', group, targetWindowId),

  // Usage. The Claude read is per account (the machine login when omitted);
  // main polls every account on its own clock and pushes each result.
  getUsageLimits: (accountId?: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke('usage:get-limits', accountId, options),
  getClaudeUsageSnapshot: () => ipcRenderer.invoke('usage:claude-snapshot'),
  onClaudeAccountUsage: (
    callback: (update: { accountId: string; result: unknown }) => void
  ) => createIpcListener<[{ accountId: string; result: unknown }]>('usage:claude-account', callback),

  // Claude accounts: the list crosses; a token goes in and never comes back.
  claudeAccountsList: () => ipcRenderer.invoke('claude-accounts:list'),
  claudeAccountAdd: (input: { label: string; configDir?: string }) =>
    ipcRenderer.invoke('claude-accounts:add', input),
  claudeAccountUpdate: (id: string, updates: { label?: string; configDir?: string }) =>
    ipcRenderer.invoke('claude-accounts:update', id, updates),
  claudeAccountRemove: (id: string) => ipcRenderer.invoke('claude-accounts:remove', id),
  claudeAccountSetToken: (id: string, token: string) =>
    ipcRenderer.invoke('claude-accounts:set-token', id, token),
  claudeAccountClearToken: (id: string) => ipcRenderer.invoke('claude-accounts:clear-token', id),
  onClaudeAccountsChanged: (callback: (accounts: unknown[]) => void) =>
    createIpcListener<[unknown[]]>('claude-accounts:changed', callback),
  getCodexUsageLimits: () => ipcRenderer.invoke('usage:get-codex-limits'),
  getPiUsage: (range: 'today' | '7d' | '30d' | 'all') => ipcRenderer.invoke('usage:get-pi', range),

  // Git
  gitCheckIgnored: (cwd: string, paths: string[]) =>
    ipcRenderer.invoke('git:check-ignored', cwd, paths),
  getGitStatus: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
  getGitStatusBatch: (paths: string[]) => ipcRenderer.invoke('git:status-batch', paths),
  gitFetch: (cwd: string) => ipcRenderer.invoke('git:fetch', cwd),
  gitFetchBatch: (paths: string[]) => ipcRenderer.invoke('git:fetch-batch', paths),
  discoverGitRepos: (cwd: string, force?: boolean) =>
    ipcRenderer.invoke('git:discover-repos', cwd, force),
  gitStage: (cwd: string, files: string[]) => ipcRenderer.invoke('git:stage', cwd, files),
  gitUnstage: (cwd: string, files: string[]) => ipcRenderer.invoke('git:unstage', cwd, files),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke('git:commit', cwd, message),
  gitPush: (cwd: string) => ipcRenderer.invoke('git:push', cwd),
  gitPublishBranch: (cwd: string) => ipcRenderer.invoke('git:publish-branch', cwd),
  gitPull: (cwd: string, strategy?: 'auto' | 'merge' | 'rebase' | 'ff-only') =>
    ipcRenderer.invoke('git:pull', cwd, strategy),
  gitDiscard: (cwd: string, files: Array<{ path: string; status: string; staged: boolean }>) =>
    ipcRenderer.invoke('git:discard', cwd, files),
  gitDiff: (cwd: string, filePath: string, staged: boolean, isUntracked: boolean) =>
    ipcRenderer.invoke('git:diff', cwd, filePath, staged, isUntracked),
  gitLog: (cwd: string, maxCount?: number) => ipcRenderer.invoke('git:log', cwd, maxCount),
  gitOutgoingCommits: (cwd: string) => ipcRenderer.invoke('git:outgoing-commits', cwd),
  gitIncomingCommits: (cwd: string) => ipcRenderer.invoke('git:incoming-commits', cwd),
  gitRangeFiles: (cwd: string, direction: GitRangeDirection) =>
    ipcRenderer.invoke('git:range-files', cwd, direction),
  gitRangeDiff: (cwd: string, direction: GitRangeDirection, filePath: string) =>
    ipcRenderer.invoke('git:range-diff', cwd, direction, filePath),
  gitCommitFiles: (cwd: string, hash: string) => ipcRenderer.invoke('git:commit-files', cwd, hash),
  gitCommitDiff: (cwd: string, hash: string, filePath: string) =>
    ipcRenderer.invoke('git:commit-diff', cwd, hash, filePath),
  gitGenerateCommitMessage: (cwd: string) => ipcRenderer.invoke('git:generate-commit-message', cwd),
  gitMagicSync: (repoPaths: string[]) => ipcRenderer.invoke('git:magic-sync', repoPaths),
  gitMagicPull: (repoPaths: string[]) => ipcRenderer.invoke('git:magic-pull', repoPaths),
  gitRefreshRemotes: (repoPaths: string[]) => ipcRenderer.invoke('git:refresh-remotes', repoPaths),
  // One channel for both batch ops — the payload's `op` says which.
  onGitBatchProgress: (callback: (progress: GitBatchProgress) => void) =>
    createIpcListener<[GitBatchProgress]>('git:batch-progress', callback),
  gitJourney: (cwd: string, maxCount?: number) => ipcRenderer.invoke('git:journey', cwd, maxCount),
  gitSummarizePush: (cwd: string, commitMessages: string[], diffStats: string) =>
    ipcRenderer.invoke('git:summarize-push', cwd, commitMessages, diffStats),

  showNotification: (options: { title: string; body: string; sessionId: string }) =>
    ipcRenderer.invoke('notification:show', options),

  onNotificationClicked: (callback: (sessionId: string) => void) =>
    createIpcListener<[string]>('notification:clicked', callback),

  // ── Locations ──
  locationList: () => ipcRenderer.invoke('location:list'),
  locationAdd: (loc: unknown, password?: string) =>
    ipcRenderer.invoke('location:add', loc, password),
  locationUpdate: (id: string, updates: unknown) =>
    ipcRenderer.invoke('location:update', id, updates),
  locationRemove: (id: string) => ipcRenderer.invoke('location:remove', id),
  locationTestConnection: (id: string) => ipcRenderer.invoke('location:test-connection', id),
  locationInstallPlugin: (id: string) => ipcRenderer.invoke('location:install-plugin', id),

  // ── SSH / Remote Terminal ──
  sshConnect: (locationId: string) => ipcRenderer.invoke('ssh:connect', locationId),
  sshDisconnect: (locationId: string) => ipcRenderer.invoke('ssh:disconnect', locationId),
  sshOpenShell: (locationId: string, cwd?: string) =>
    ipcRenderer.invoke('ssh:open-shell', locationId, cwd),
  sshShellWrite: (shellId: string, data: string) =>
    ipcRenderer.send('ssh:shell-write', shellId, data),
  sshShellResize: (shellId: string, cols: number, rows: number) =>
    ipcRenderer.send('ssh:shell-resize', shellId, cols, rows),
  sshExec: (locationId: string, command: string) =>
    ipcRenderer.invoke('ssh:exec', locationId, command),
  sshShellClose: (shellId: string) => ipcRenderer.invoke('ssh:shell-close', shellId),
  onSshShellData: (shellId: string, callback: (data: string) => void) =>
    createIpcListener<[string]>(`ssh:shell-data:${shellId}`, callback),
  onSshShellExit: (shellId: string, callback: (exitCode: number) => void) =>
    createIpcListener<[number]>(`ssh:shell-exit:${shellId}`, callback),
  onSshConnectionClosed: (callback: (locationId: string) => void) =>
    createIpcListener<[string]>('ssh:connection-closed', callback),

  // ── Remote FS (SFTP) ──
  sftpReadDir: (locationId: string, dirPath: string) =>
    ipcRenderer.invoke('sftp:read-dir', locationId, dirPath),
  sftpReadFile: (locationId: string, filePath: string) =>
    ipcRenderer.invoke('sftp:read-file', locationId, filePath),
  sftpStat: (locationId: string, filePath: string) =>
    ipcRenderer.invoke('sftp:stat', locationId, filePath),

  // ── Agents ──
  agentList: (locationId: string) => ipcRenderer.invoke('agent:list', locationId),
  agentConnect: (locationId: string) => ipcRenderer.invoke('agent:connect', locationId),
  agentDisconnect: (locationId: string) => ipcRenderer.invoke('agent:disconnect', locationId),
  agentSessions: (locationId: string) => ipcRenderer.invoke('agent:sessions', locationId),
  agentChatHistory: (locationId: string, sessionKey: string) =>
    ipcRenderer.invoke('agent:chat-history', locationId, sessionKey),
  agentSend: (agentId: string, locationId: string, content: string) =>
    ipcRenderer.invoke('agent:send', agentId, locationId, content),
  onAgentMessage: (agentId: string, callback: (message: unknown) => void) =>
    createIpcListener<[unknown]>(`agent:on-message:${agentId}`, callback),
  onAgentsUpdated: (callback: (locationId: string, agents: unknown[]) => void) =>
    createIpcListener<[string, unknown[]]>('agent:agents-updated', callback),

  // ── .clave files ──
  readClaveFile: (absolutePath: string, rootDir?: string) =>
    ipcRenderer.invoke('clave:read-file', absolutePath, rootDir),
  writeClaveFile: (absolutePath: string, data: unknown, rootDir?: string) =>
    ipcRenderer.invoke('clave:write-file', absolutePath, data, rootDir),
  watchClaveFile: (absolutePath: string) => ipcRenderer.invoke('clave:watch-file', absolutePath),
  unwatchClaveFile: (absolutePath: string) =>
    ipcRenderer.invoke('clave:unwatch-file', absolutePath),
  onClaveFileChanged: (callback: (filePath: string) => void) =>
    createIpcListener<[string]>('clave:file-changed', callback),
  saveFileDialog: (defaultName: string, filters: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('dialog:saveFile', defaultName, filters),
  getDownloadsPath: () => ipcRenderer.invoke('app:get-downloads-path') as Promise<string>,
  getUserDataPath: () => ipcRenderer.invoke('app:get-user-data-path') as Promise<string>,
  claveFileExists: (absolutePath: string) =>
    ipcRenderer.invoke('clave:file-exists', absolutePath) as Promise<boolean>,
  discoverClaveFiles: (folderPath: string) =>
    ipcRenderer.invoke('clave:discover-files', folderPath) as Promise<
      { name: string; path: string; rootDir: string | null }[]
    >,
  discoverClaveFilesRecursive: (
    rootDir: string,
    config?: { patterns?: string[]; exclude?: string[]; maxDepth?: number; workspaceId?: string }
  ) =>
    ipcRenderer.invoke('clave:discover-files-recursive', rootDir, config) as Promise<
      { name: string; path: string; rootDir: string }[]
    >,
  readAutoDiscoverConfig: (filePath: string) =>
    ipcRenderer.invoke('clave:read-auto-discover', filePath) as Promise<{
      enabled: boolean
      patterns?: string[]
      exclude?: string[]
      maxDepth?: number
    } | null>,
  readImageAsDataUrl: (absolutePath: string) =>
    ipcRenderer.invoke('clave:read-image', absolutePath) as Promise<string | null>,
  preferencesGet: (key: string) => ipcRenderer.invoke('preferences:get', key),
  preferencesSet: (key: string, value: unknown) =>
    ipcRenderer.invoke('preferences:set', key, value),
  keymapsLoad: () => ipcRenderer.invoke('keymaps:load'),
  keymapsSave: (value: unknown) => ipcRenderer.invoke('keymaps:save', value),
  keymapsImport: () => ipcRenderer.invoke('keymaps:import') as Promise<string | null>,
  keymapsExport: (json: string) => ipcRenderer.invoke('keymaps:export', json) as Promise<boolean>,
  onKeymapsChanged: (callback: (value: unknown) => void) =>
    createIpcListener<[unknown]>('keymaps:changed', callback),
  trustWorkspaceRoot: (root: string) =>
    ipcRenderer.invoke('clave:trust-root', root) as Promise<void>,
  untrustWorkspaceRoot: (root: string) =>
    ipcRenderer.invoke('clave:untrust-root', root) as Promise<void>,
  listTrustedRoots: () => ipcRenderer.invoke('clave:list-trusted-roots') as Promise<string[]>,

  // ── Extensions (inventory of installed plugins/skills/MCP + management) ──
  extensionsGetInventory: (configDir?: string) =>
    ipcRenderer.invoke('extensions:get-inventory', configDir),
  extensionsInstallPlugin: (pluginId: string, scope: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:install-plugin', pluginId, scope, configDir),
  extensionsUninstallPlugin: (pluginId: string, scope: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:uninstall-plugin', pluginId, scope, configDir),
  extensionsSetPluginEnabled: (
    pluginId: string,
    enabled: boolean,
    scope: string,
    configDir?: string
  ) => ipcRenderer.invoke('extensions:set-plugin-enabled', pluginId, enabled, scope, configDir),
  extensionsAddMarketplace: (source: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:add-marketplace', source, configDir),
  extensionsRemoveMarketplace: (name: string, configDir?: string) =>
    ipcRenderer.invoke('extensions:remove-marketplace', name, configDir),

  // ── Telemetry ──
  telemetryGetState: () =>
    ipcRenderer.invoke('telemetry:get-state') as Promise<{
      enabled: boolean
      installId: string | null
      lastPingAt: string | null
      noticeShown: boolean
    }>,
  telemetrySetEnabled: (enabled: boolean) => ipcRenderer.invoke('telemetry:set-enabled', enabled),
  telemetrySetNoticeShown: () => ipcRenderer.invoke('telemetry:set-notice-shown'),

  // ── Feedback ──
  feedbackGetState: () =>
    ipcRenderer.invoke('feedback:get-state') as Promise<{ collapsed: boolean }>,
  feedbackSetCollapsed: () => ipcRenderer.invoke('feedback:set-collapsed'),
  feedbackSubmit: (submission: { email: string; message?: string }) =>
    ipcRenderer.invoke('feedback:submit', submission) as Promise<
      { ok: true } | { ok: false; error: string }
    >
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

/**
 * `--test-no-activate` again, this time so the RENDERER can see it.
 *
 * The main process reads this flag off the app's own command line
 * (`src/main/test-mode.ts`) and, when it is set, repeats it into the window's
 * `additionalArguments` — which is what puts it on the argv read here. A
 * preload's own `process.argv` is the RENDERER process's command line and
 * carries Chromium's switches, not the app's, so without that repeat this
 * lookup finds nothing.
 *
 * What it gates: the E2E-only seams that must not exist in a shipped app, such
 * as the updater store handle a spec writes through. Never passed in a build a
 * user runs, so those seams are absent there.
 */
contextBridge.exposeInMainWorld('__claveTestMode', process.argv.includes('--test-no-activate'))
