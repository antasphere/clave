/**
 * Where every member of `window.electronAPI` runs for a tab on another Clave
 * server (PRDCT-4329).
 *
 * The window's API is this Mac's bridge (`index.ts`) wrapped whole by
 * `createFleetDesktop` (`fleet-desktop.ts`), which overrides the members that
 * reach the server a key names. A member it does not override runs on THIS
 * Mac whatever id or path it is given, and a server tab is stored with
 * `sessionType: 'local'`, so nothing else stops it. This table is the record
 * of that choice, one entry per member, and `api-placement.test.ts` holds it
 * to the real exposed object: a member with no entry fails the test, and so
 * does an entry that says `routed` for a member the wrapper does not override
 * (or `local` for one it does).
 *
 * - `routed`: the wrapper sends a server key's call to that server.
 * - `local`: acts on this Mac on purpose (a window, a dialog, a notification,
 *   this Mac's own settings). One that takes a session id, a cwd or a path
 *   says why in a line.
 * - `refused-for-remote`: the wrapper answers a server key with a refusal
 *   (an error, `false`, or nothing done) rather than acting on this Mac.
 *
 * `wrongForServerTab` is `local` with the admission that it is NOT right for
 * a server tab today: the line names the task that fixes it, or says it is
 * not yet filed. Those entries are the list of what is left.
 */
export type Placement = 'routed' | 'local' | 'refused-for-remote'

export interface Declaration {
  readonly placement: Placement
  /** Why, for a `local` member that takes a session id, a cwd or a path,
   *  and for every refusal. */
  readonly why?: string
  /** A `local` member that acts on the wrong machine for a server tab. */
  readonly wrongForServerTab?: true
}

const routed: Declaration = { placement: 'routed' }
const local: Declaration = { placement: 'local' }
const localBecause = (why: string): Declaration => ({ placement: 'local', why })
const refused = (why: string): Declaration => ({ placement: 'refused-for-remote', why })
const wrongForServerTab = (why: string): Declaration => ({
  placement: 'local',
  why,
  wrongForServerTab: true
})

/** Keyed by member name; a namespace's members as `namespace.member`. */
export const API_PLACEMENT: Readonly<Record<string, Declaration>> = {
  onServerRefusal: local,
  onServerConnected: local,
  lineageParents: localBecause("this Mac's records"),
  sessionsList: routed,
  sessionsSubscribe: routed,
  sessionsUnsubscribe: routed,
  sessionsWrite: routed,
  sessionsSetView: routed,
  sessionsModels: routed,
  adaptersList: local,
  adaptersModels: wrongForServerTab(
    "a server tab's cwd is read on this Mac when the model menu lists a provider's models (not yet filed)"
  ),
  providerSwitchPlan: wrongForServerTab(
    "the provider switch of a server tab reads this Mac's server (not yet filed)"
  ),
  providerSwitchConvert: wrongForServerTab(
    'the provider switch of a server tab converts on this Mac (not yet filed)'
  ),
  providerSwitchHandoff: wrongForServerTab(
    'the handoff of a server tab is written on this Mac (not yet filed)'
  ),
  sessionsCommands: routed,
  sessionsControl: wrongForServerTab(
    "a server chat's MCP and plugin panels ask this Mac's server with the key (not yet filed; the server client has sessions.control)"
  ),
  sessionsCapabilities: routed,
  sessionsHistory: routed,
  'sessionsFiles.prepare': routed,
  'sessionsFiles.pick': localBecause(
    'a file dialog of this Mac; the file picked is uploaded to a server tab by prepare()'
  ),
  'sessionsFiles.preview': routed,
  'sessionsFiles.open': routed,
  onSessionStream: routed,
  onSessionStreamExit: routed,
  pluginsList: local,
  pluginsViewLease: refused(
    "a plugin surface view runs in this Mac's plugin host: a server key is refused"
  ),
  pluginsViewRequest: local,
  pluginsViewRevoke: local,
  onPluginViewEvent: local,
  pluginsEnable: local,
  pluginsDisable: local,
  pluginsLink: localBecause('links a plugin folder of this Mac'),
  pluginsRemove: local,
  pluginsCommand: local,
  pluginsInvokeAction: local,
  pluginsPreviewAction: local,
  pluginsPanel: local,
  pluginsContext: refused("the plugin host's focus is this Mac's: a server key is ignored"),
  pluginsSecrets: local,
  pluginsSecretReply: local,
  onPluginsChanged: local,
  platform: local,
  launchProfilesList: local,
  launchProfileUpsert: local,
  launchProfileDelete: local,
  launchProfileSetGlobal: local,
  launchProfileSetWorkspace: local,
  spawnSession: routed,
  writeSession: routed,
  startSession: routed,
  resizeSession: routed,
  killSession: routed,
  listSessions: localBecause("this Mac's ptys; a server's come in fleetSnapshot"),
  setSessionDisplayName: routed,
  setSessionViewRecord: routed,
  sessionsChangeWork: wrongForServerTab(
    "a server tab's work assignment is written to this Mac's records (not yet filed; the server client has sessions.changeWork)"
  ),
  setSessionWorkspace: routed,
  tmuxAvailable: local,
  listSessionRecords: localBecause("this Mac's records; a server's come in fleetSnapshot"),
  listServerRestoreRecords: localBecause("this Mac's server's records"),
  serverHasRestoreRecords: local,
  bootRecordsComplete: local,
  discardSessionRecord: wrongForServerTab(
    "discards this Mac's record by key: a server tab's record stays on the server (not yet filed)"
  ),
  onSessionRehome: localBecause("a move between this Mac's windows"),
  onSessionRemovedForRehome: localBecause("a move between this Mac's windows"),
  onGroupRemovedForMove: localBecause("a move between this Mac's windows"),
  ackRehomed: localBecause("a move between this Mac's windows"),
  onSessionRenamed: routed,
  onSessionWorkChanged: wrongForServerTab(
    "only this Mac's server's work changes are heard: a server tab's are not relayed (not yet filed)"
  ),
  onSessionPageChanged: wrongForServerTab(
    "only this Mac's server's page changes are heard: a server tab's are not relayed (not yet filed)"
  ),
  onSessionTyped: routed,
  onSessionRestarting: routed,
  onSessionModelChanged: routed,
  onSessionRestarted: routed,
  onPinnedGroupLaunched: localBecause("this Mac's pinned groups"),
  onSessionData: routed,
  onSessionExit: routed,
  onSessionAutoTitle: routed,
  onPlanDetected: routed,
  onSessionLimitReported: routed,
  onClearDetected: routed,
  onAgentState: routed,
  onMcpCommand: local,
  mcpRespond: local,
  captureExchangeMessage: localBecause("this Mac's activity ledger, for every tab of the window"),
  captureTabSpawn: localBecause("this Mac's activity ledger, for every tab of the window"),
  captureSessionState: localBecause("this Mac's activity ledger, for every tab of the window"),
  captureTabClosed: localBecause("this Mac's activity ledger, for every tab of the window"),
  activityQuery: local,
  onActivityChanged: local,
  sessionsReportState: refused(
    "the state a pane reports is this Mac's server's: a server tab's is dropped"
  ),
  historyStamp: localBecause("this Mac's History index; PRDCT-4321, the History lane"),
  historyRestamp: localBecause("this Mac's History index; PRDCT-4321, the History lane"),
  historyList: localBecause("this Mac's History index; PRDCT-4321, the History lane"),
  historyConversation: wrongForServerTab(
    "reads a transcript under the cwd on this Mac's disk; PRDCT-4321, the History lane"
  ),
  scrollSessionToText: wrongForServerTab(
    "scrolls this Mac's pane by id: a server tab's pane is not found (not yet filed)"
  ),
  historySearch: localBecause("this Mac's History index; PRDCT-4321, the History lane"),
  historySearchCancel: localBecause("this Mac's History index; PRDCT-4321, the History lane"),
  onHistorySearchHits: localBecause("this Mac's History index; PRDCT-4321, the History lane"),
  setSessionClaudeSessionId: wrongForServerTab(
    "a server terminal's /clear is recorded on this Mac's record (not yet filed)"
  ),
  secretList: local,
  secretSubmit: local,
  secretDismiss: local,
  onSecretRequestsChanged: local,
  'slideless.getState': local,
  'slideless.install': local,
  'slideless.serve': wrongForServerTab(
    "serves a target of this Mac's disk: a server file's key is not served (unverified, not yet filed)"
  ),
  'slideless.release': localBecause('releases the lease serve() gave on this Mac'),
  'slideless.snapshot': wrongForServerTab(
    "snapshots a target of this Mac's disk (unverified for a server file, not yet filed)"
  ),
  'slideless.onState': local,
  'slideless.onServerExited': local,
  'linkedDocuments.getDefaultSignature': local,
  'linkedDocuments.setDefaultSignature': localBecause('a file of this Mac'),
  'linkedDocuments.list': local,
  'linkedDocuments.open': wrongForServerTab(
    'opens a linked document on this Mac for the calling session id (unverified for a server tab, not yet filed)'
  ),
  'linkedDocuments.update': local,
  'linkedDocuments.openAttachment': local,
  'linkedDocuments.chooseFiles': localBecause('a dialog of this Mac'),
  'linkedDocuments.onChanged': local,
  routinesList: local,
  routinesRunNow: local,
  routinesDismiss: local,
  routinesOpenDiscussion: local,
  routinesCreate: local,
  routinesUpdate: local,
  routinesDelete: local,
  routinesPause: local,
  routinesOwnName: local,
  routinesSetOwnName: local,
  onRoutinesChanged: local,
  routinesCacheRemoteDeck: localBecause("this Mac's cache of a server's deck, by its server id"),
  copyOfferList: local,
  copyOfferCopy: local,
  copyOfferDismiss: local,
  copyOfferDismissSession: wrongForServerTab(
    "the copy offers are this Mac's: a server tab's are never offered nor dismissed here (not yet filed)"
  ),
  onCopyOffersChanged: local,
  saveDiscussion: wrongForServerTab(
    "reads the transcript under the cwd on this Mac's disk: a server tab's transcript is on the server (not yet filed)"
  ),
  savePlan: wrongForServerTab(
    "reads the plan under the cwd on this Mac's disk: a server tab's is on the server (not yet filed)"
  ),
  saveTranscript: local,
  openExternal: local,
  exchangeDigest: wrongForServerTab('digests are read on this Mac: PRDCT-4327 routes it'),
  exchangeDigestsOf: wrongForServerTab('digests are read on this Mac: PRDCT-4327 routes it'),
  workDigest: wrongForServerTab('digests are read on this Mac: PRDCT-4327 routes it'),
  workDigestsOf: wrongForServerTab('digests are read on this Mac: PRDCT-4327 routes it'),
  githubPull: local,
  githubPullDiff: local,
  githubPullComment: local,
  githubPullReview: local,
  githubPullMerge: local,
  checkPort: local,
  probeServerUrl: local,
  serverSetupScan: local,
  serverSetupInstallStatus: local,
  serverSetupInstall: local,
  serverSetupCopyToken: local,
  onServerSetupProgress: local,
  openPath: routed,
  registerHtmlPreview: wrongForServerTab(
    "serves a path of this Mac's disk: a server file's key is not served (not yet filed)"
  ),
  openFolderDialog: localBecause(
    'a dialog of this Mac; a server tab picks with the server picker (pickServerFolder) instead'
  ),
  openFileDialog: localBecause(
    'a dialog of this Mac; its path is uploaded, never sent as a server path'
  ),
  onUpdateAvailable: local,
  onUpdateDownloaded: local,
  onDownloadProgress: local,
  onDownloadError: local,
  onUpdaterState: local,
  onOpenSettingsSection: local,
  onOpenTriage: local,
  onboardingGetState: local,
  onboardingAgents: local,
  onboardingInstall: local,
  onboardingComplete: local,
  onboardingSetChatView: local,
  onboardingCreateFolder: localBecause('onboarding creates a folder on this Mac'),
  onOpenOnboarding: local,
  onMissionControlEntered: local,
  onMissionControlExited: local,
  missionControlGetEnabled: local,
  missionControlSetEnabled: local,
  setAppIcon: local,
  hapticTick: local,
  getUsername: local,
  saveAvatar: localBecause("the avatar file is this Mac's"),
  getAppVersion: local,
  installUpdate: local,
  startDownload: local,
  openUpdaterLog: local,
  openReleasesPage: local,
  cancelDownload: local,
  getUpdaterState: local,
  checkForUpdates: local,
  setPrereleaseUpdates: local,
  getAgentUpdates: localBecause(
    "this Mac's CLIs; the restart hint is not drawn on a server tab from them"
  ),
  checkAgentUpdates: local,
  updateAgent: local,
  setAgentAutoUpdate: local,
  onAgentUpdatesState: localBecause(
    "this Mac's CLIs; the restart hint is not drawn on a server tab from them"
  ),
  getPathForFile: localBecause("a file dropped from this Mac's Finder"),
  persistDroppedFile: localBecause("copies a file dropped from this Mac's Finder"),
  listFiles: routed,
  readDir: routed,
  existsSync: refused("a synchronous read of this Mac's disk: a server root answers false"),
  readFile: routed,
  statFile: routed,
  writeFile: routed,
  createFile: routed,
  createDirectory: routed,
  showItemInFolder: refused("Finder is this Mac's: a server file is refused"),
  watchDir: routed,
  unwatchDir: routed,
  onFsChanged: routed,
  sidebarLayoutLoad: localBecause("this window's layout; a server's goes through fleetSaveLayout"),
  sidebarLayoutSave: localBecause("this window's layout; a server's goes through fleetSaveLayout"),
  onSidebarLayoutChanged: local,
  serverPairingsLoad: local,
  serverPairingsChange: local,
  onServerPairingsChanged: local,
  workspaceLoad: local,
  workspaceUpdateRegistry: local,
  workspaceUpdatePins: local,
  workspaceSetLastActive: local,
  onWorkspaceStateChanged: local,
  windowIdentity: local,
  onWindowIdentityChanged: local,
  windowSetWorkspace: local,
  windowIsFullScreen: local,
  onWindowFullScreenChanged: local,
  windowList: local,
  windowOpen: local,
  windowMoveSessions: wrongForServerTab(
    "moves tabs between this Mac's windows; a server tab's id is not this Mac's session (not yet filed)"
  ),
  windowMoveGroup: localBecause("a move between this Mac's windows"),
  getUsageLimits: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  getClaudeUsageSnapshot: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  onClaudeAccountUsage: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountsList: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountsMigrated: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountAdd: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountUpdate: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountReorder: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountRemove: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountSetToken: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  claudeAccountClearToken: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  onClaudeAccountsChanged: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  codexAccountsList: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  codexAccountAdd: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  codexAccountUpdate: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  codexAccountReorder: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  codexAccountRemove: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  codexAccountClearCredential: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  onCodexAccountsChanged: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  accountLoginStart: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  accountLoginApiKey: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  accountLoginInput: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  accountLoginCancel: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  accountLoginList: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  onAccountLoginProgress: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  antasphereAccountGet: local,
  antasphereAccountSignIn: local,
  antasphereAccountCancel: local,
  antasphereAccountSignOut: local,
  antasphereAccountDismiss: local,
  onAntasphereAccountChanged: local,
  getCodexUsageLimits: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  getCodexUsageSnapshot: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  onCodexAccountUsage: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  restartSession: routed,
  getPiUsage: local,
  gitCheckIgnored: routed,
  getGitStatus: routed,
  gitRemoteUrl: routed,
  getGitStatusBatch: routed,
  gitFetch: routed,
  gitFetchBatch: routed,
  gitWatchRepos: routed,
  gitUnwatchRepos: routed,
  onGitReposChanged: routed,
  discoverGitRepos: routed,
  gitStage: routed,
  gitUnstage: routed,
  gitCommit: routed,
  gitPush: routed,
  gitPublishBranch: routed,
  gitPull: routed,
  gitDiscard: routed,
  gitDiff: routed,
  gitLog: routed,
  gitOutgoingCommits: routed,
  gitIncomingCommits: routed,
  gitRangeFiles: routed,
  gitRangeDiff: routed,
  gitCommitFiles: routed,
  gitCommitDiff: routed,
  gitGenerateCommitMessage: routed,
  gitMagicSync: routed,
  gitMagicPull: routed,
  gitRefreshRemotes: routed,
  onGitBatchProgress: routed,
  gitJourney: routed,
  gitSummarizePush: routed,
  showNotification: localBecause(
    'a notification of this Mac; the click hands back the session id as given'
  ),
  onNotificationClicked: localBecause('a notification of this Mac'),
  locationList: local,
  locationAdd: local,
  locationUpdate: local,
  locationRemove: local,
  locationTestConnection: local,
  locationInstallPlugin: local,
  sshConnect: local,
  sshDisconnect: local,
  sshOpenShell: localBecause("an SSH location of this Mac's, not a Clave server"),
  sshShellWrite: local,
  sshShellResize: local,
  sshExec: local,
  sshShellClose: local,
  onSshShellData: local,
  onSshShellExit: local,
  onSshConnectionClosed: local,
  sftpReadDir: localBecause('a path on an SSH location of this Mac, not a Clave server'),
  sftpReadFile: localBecause('a path on an SSH location of this Mac, not a Clave server'),
  sftpStat: localBecause('a path on an SSH location of this Mac, not a Clave server'),
  agentList: local,
  agentConnect: local,
  agentDisconnect: local,
  agentSessions: local,
  agentChatHistory: local,
  agentSend: local,
  onAgentMessage: local,
  onAgentsUpdated: local,
  readClaveFile: routed,
  writeClaveFile: routed,
  watchClaveFile: routed,
  unwatchClaveFile: routed,
  onClaveFileChanged: routed,
  saveFileDialog: localBecause('a dialog of this Mac'),
  getDownloadsPath: local,
  getUserDataPath: local,
  claveFileExists: routed,
  discoverClaveFiles: routed,
  discoverClaveFilesRecursive: routed,
  readAutoDiscoverConfig: routed,
  readImageAsDataUrl: routed,
  skinsList: local,
  skinsActivate: local,
  skinsImport: localBecause('a skin folder of this Mac'),
  skinsRemove: local,
  onSkinsChanged: local,
  preferencesGet: local,
  preferencesSet: local,
  onRecommendedAccountChanged: localBecause(
    "this Mac's accounts and usage; a server tab's: PRDCT-4328, the accounts lane (fleetAccounts, fleetUsage)"
  ),
  getMicAccess: local,
  requestMicAccess: local,
  openMicPrivacySettings: local,
  openSoundSettings: local,
  keymapsLoad: local,
  keymapsSave: local,
  keymapsImport: local,
  keymapsExport: local,
  onKeymapsChanged: local,
  trustWorkspaceRoot: routed,
  untrustWorkspaceRoot: routed,
  listTrustedRoots: routed,
  extensionsGetInventory: localBecause("this Mac's agent config directory"),
  extensionsInstallPlugin: localBecause("this Mac's agent config directory"),
  extensionsUninstallPlugin: localBecause("this Mac's agent config directory"),
  extensionsSetPluginEnabled: localBecause("this Mac's agent config directory"),
  extensionsAddMarketplace: localBecause("this Mac's agent config directory"),
  extensionsRemoveMarketplace: localBecause("this Mac's agent config directory"),
  telemetryGetState: local,
  telemetrySetEnabled: local,
  telemetrySetNoticeShown: local,
  feedbackGetState: local,
  feedbackSetCollapsed: local,
  feedbackSubmit: local,
  triagePrepare: local,
  triageSnapshot: local,
  fleetList: local,
  fleetSave: local,
  fleetConnect: local,
  fleetDisconnect: local,
  fleetRemove: local,
  fleetSnapshot: routed,
  fleetStart: routed,
  fleetScreen: routed,
  fleetLaunchSettings: routed,
  fleetAccounts: routed,
  fleetUsage: routed,
  fleetUsageSnapshot: routed,
  fleetLaunchProfileUpsert: routed,
  fleetLaunchProfileDelete: routed,
  fleetLaunchProfileSetGlobal: routed,
  fleetSaveLayout: routed,
  fleetWorkspaces: routed,
  fleetAddWorkspace: routed,
  fleetRemoveWorkspace: routed,
  fleetReorderWorkspaces: routed,
  fleetResolve: routed,
  fleetDownload: routed,
  fleetUpload: routed,
  onFleetSnapshot: routed,
  onFleetSettingsEvent: routed,
  onFleetRequests: routed,
  onFleetStatus: routed,
  onFleetConnectionsChanged: local,
  onFleetWorkspaces: routed,
  fleetRoutines: routed,
  fleetRoutineRunNow: routed,
  fleetRoutineDismiss: routed,
  fleetRoutineDiscussion: routed,
  fleetRoutineDeck: routed,
  fleetRoutineCreate: routed,
  fleetRoutineUpdate: routed,
  fleetRoutineDelete: routed,
  fleetRoutinePause: routed,
  onFleetRoutines: routed,
  fleetServerVersions: routed,
  fleetUpgradeServer: routed,
  fleetSetServerName: routed,
  onFleetServerVersions: routed
}
