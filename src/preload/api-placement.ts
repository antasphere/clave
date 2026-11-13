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
 * PRDCT-4334. Those entries are the list of what is left.
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
    "a server tab's cwd is read on this Mac when the model menu lists a provider's models (PRDCT-4334)"
  ),
  providerSwitchPlan: wrongForServerTab(
    "the provider switch of a server tab reads this Mac's server (PRDCT-4334)"
  ),
  providerSwitchConvert: wrongForServerTab(
    'the provider switch of a server tab converts on this Mac (PRDCT-4334)'
  ),
  providerSwitchHandoff: wrongForServerTab(
    'the handoff of a server tab is written on this Mac (PRDCT-4334)'
  ),
  sessionsCommands: routed,
  sessionsControl: wrongForServerTab(
    "a server chat's MCP and plugin panels ask this Mac's server with the key (PRDCT-4334; the server client has sessions.control)"
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
  pluginsInvokeAction: wrongForServerTab(
    "the Sidebar offers plugin actions on server tabs and groups: this Mac's plugin host gets a server key as the target id (PRDCT-4334)"
  ),
  pluginsPreviewAction: wrongForServerTab(
    "the Sidebar offers plugin actions on server tabs and groups: this Mac's plugin host gets a server key as the target id (PRDCT-4334)"
  ),
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
  helpersList: localBecause("this Mac's helpers; a server's are fleetHelpers"),
  helperSet: localBecause("this Mac's helpers; a server's are fleetHelperSet"),
  integrationsRead: localBecause("this Mac's integrations; a server's are fleetIntegrations"),
  elevenLabsSetKey: localBecause("this Mac's ElevenLabs key; a server's is fleetElevenLabsSetKey"),
  elevenLabsCheck: localBecause("this Mac's ElevenLabs key; a server's is fleetElevenLabsCheck"),
  elevenLabsRemove: localBecause("this Mac's ElevenLabs key; a server's is fleetElevenLabsRemove"),
  elevenLabsSetVoice: localBecause("this Mac's voice; a server's is fleetElevenLabsSetVoice"),
  elevenLabsVoices: localBecause("this Mac's voices; a server's are fleetElevenLabsVoices"),
  elevenLabsPreview: localBecause("this Mac's voice preview; a server's is fleetElevenLabsPreview"),
  spawnSession: routed,
  writeSession: routed,
  startSession: routed,
  resizeSession: routed,
  killSession: routed,
  listSessions: localBecause("this Mac's ptys; a server's come in fleetSnapshot"),
  setSessionDisplayName: routed,
  setSessionViewRecord: routed,
  sessionsChangeWork: wrongForServerTab(
    "a server tab's work assignment is written to this Mac's records (PRDCT-4334; the server client has sessions.changeWork)"
  ),
  setSessionWorkspace: routed,
  tmuxAvailable: local,
  listSessionRecords: localBecause("this Mac's records; a server's come in fleetSnapshot"),
  listServerRestoreRecords: localBecause("this Mac's server's records"),
  serverHasRestoreRecords: local,
  bootRecordsComplete: local,
  discardSessionRecord: wrongForServerTab(
    "discards this Mac's record by key: a server tab's record stays on the server (PRDCT-4334)"
  ),
  onSessionRehome: localBecause("a move between this Mac's windows"),
  onSessionRemovedForRehome: localBecause("a move between this Mac's windows"),
  onGroupRemovedForMove: localBecause("a move between this Mac's windows"),
  ackRehomed: localBecause("a move between this Mac's windows"),
  onSessionRenamed: routed,
  onSessionWorkChanged: wrongForServerTab(
    "only this Mac's server's work changes are heard: a server tab's are not relayed (PRDCT-4334)"
  ),
  onSessionPageChanged: wrongForServerTab(
    "only this Mac's server's page changes are heard: a server tab's are not relayed (PRDCT-4334)"
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
  onSessionLimitCleared: routed,
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
  historyStamp: localBecause("this Mac's History ledger; a server keeps its own (PRDCT-4321)"),
  historyRestamp: localBecause("this Mac's History ledger; a server keeps its own (PRDCT-4321)"),
  historyList: localBecause(
    "this Mac's History, with each connected server's own laid in by this Mac (PRDCT-4321)"
  ),
  historyConversation: wrongForServerTab(
    "reads a transcript under the cwd on this Mac's disk: a server tab's is on the server (PRDCT-4334)"
  ),
  scrollSessionToText: wrongForServerTab(
    "scrolls this Mac's pane by id: a server tab's pane is not found (PRDCT-4334)"
  ),
  historySearch: localBecause(
    "this Mac's transcripts, and each server asked for its own conversations (PRDCT-4321)"
  ),
  historySearchCancel: localBecause(
    'cancels a search this Mac runs, the parts a server runs included (PRDCT-4321)'
  ),
  onHistorySearchHits: localBecause(
    "the hits of a search this Mac runs, a server's included (PRDCT-4321)"
  ),
  setSessionClaudeSessionId: routed,
  secretList: local,
  secretSubmit: local,
  secretDismiss: local,
  onSecretRequestsChanged: local,
  // ── PRDCT-4474: a session's artefact, on the server it runs on ──
  'artefacts.list': routed,
  'artefacts.hold': routed,
  'artefacts.release': routed,
  'artefacts.saveVersion': routed,
  'artefacts.versions': routed,
  'artefacts.close': routed,
  'artefacts.onChanged': routed,
  'artefacts.onPreviewExited': routed,
  'artefacts.slidelessState': routed,
  'artefacts.installSlideless': routed,
  'artefacts.onSlidelessState': routed,
  'linkedDocuments.getDefaultSignature': local,
  'linkedDocuments.setDefaultSignature': localBecause('a file of this Mac'),
  'linkedDocuments.list': local,
  'linkedDocuments.open': wrongForServerTab(
    'opens a linked document on this Mac for the calling session id (unverified for a server tab, PRDCT-4334)'
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
    "the copy offers are this Mac's: a server tab's are never offered nor dismissed here (PRDCT-4334)"
  ),
  onCopyOffersChanged: local,
  saveDiscussion: wrongForServerTab(
    "reads the transcript under the cwd on this Mac's disk: a server tab's transcript is on the server (PRDCT-4334)"
  ),
  savePlan: wrongForServerTab(
    "reads the plan under the cwd on this Mac's disk: a server tab's is on the server (PRDCT-4334)"
  ),
  saveTranscript: local,
  openExternal: local,
  exchangeDigest: routed,
  exchangeDigestsOf: routed,
  workDigest: routed,
  workDigestsOf: routed,
  spokenRendering: routed,
  spokenRenderingsOf: routed,
  speakText: routed,
  pageTitle: routed,
  pageTitlesOf: routed,
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
    "serves a path of this Mac's disk: a server file's key is not served (PRDCT-4334)"
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
    "moves tabs between this Mac's windows; a server tab's id is not this Mac's session (PRDCT-4334)"
  ),
  windowMoveGroup: wrongForServerTab(
    "server groups get the move-to-window menu, and this Mac's windows move a server group's id they do not own (PRDCT-4334)"
  ),
  getUsageLimits: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  getClaudeUsageSnapshot: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  onClaudeAccountUsage: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  claudeAccountsList: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  claudeAccountsMigrated: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  claudeAccountAdd: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  claudeAccountUpdate: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  claudeAccountReorder: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  claudeAccountRemove: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  claudeAccountSetToken: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  claudeAccountClearToken: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  onClaudeAccountsChanged: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  codexAccountsList: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  codexAccountAdd: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  codexAccountUpdate: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  codexAccountReorder: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  codexAccountRemove: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  codexAccountClearCredential: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  onCodexAccountsChanged: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  accountLoginStart: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  accountLoginApiKey: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  accountLoginInput: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  accountLoginCancel: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  accountLoginList: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  onAccountLoginProgress: localBecause(
    "this Mac's accounts, on purpose; a server's are signed in on the server itself and only read here (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  antasphereAccountGet: local,
  antasphereAccountSignIn: local,
  antasphereAccountCancel: local,
  antasphereAccountSignOut: local,
  antasphereAccountDismiss: local,
  onAntasphereAccountChanged: local,
  getCodexUsageLimits: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  getCodexUsageSnapshot: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
  ),
  onCodexAccountUsage: localBecause(
    "this Mac's accounts and usage, on purpose; a server tab's are its server's, read by the seam (session-accounts.ts: fleetAccounts, fleetUsage; PRDCT-4328)"
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
    "this Mac's launch choice, on purpose; a server tab's account is its server's, read by the seam (session-accounts.ts: fleetAccounts; PRDCT-4328)"
  ),
  // The launch settings are this Mac's (PRDCT-4423, PRDCT-4425): the
  // interaction mode and the per-harness defaults the launcher reads; a
  // server's launcher reads its own, through the fleet's settings.
  launchSettingsGet: local,
  launchSettingsSet: local,
  onLaunchSettingsChanged: local,
  launchRememberedModel: localBecause(
    "this Mac's composer pick, by adapter id; a server tab's model is judged by its server (PRDCT-4420)"
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
  extensionsGetInventory: wrongForServerTab(
    "a server chat's plugin panel (PluginPanel) lists this Mac's plugins, not the server's (PRDCT-4334)"
  ),
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
  fleetHelpers: routed,
  fleetHelperSet: routed,
  fleetIntegrations: routed,
  fleetElevenLabsSetKey: routed,
  fleetElevenLabsCheck: routed,
  fleetElevenLabsRemove: routed,
  fleetElevenLabsSetVoice: routed,
  fleetElevenLabsVoices: routed,
  fleetElevenLabsPreview: routed,
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
  onFleetServerVersions: routed,
  // ── Lane B (harness wave): provider connections ──
  providerConnectionsList: localBecause(
    "this Mac's provider connections; a server's are fleetProviderConnections"
  ),
  providerConnectionAdd: localBecause(
    "this Mac's provider connections; a server's are fleetProviderConnections"
  ),
  providerConnectionRename: localBecause(
    "this Mac's provider connections; a server's are fleetProviderConnections"
  ),
  providerConnectionRemove: localBecause(
    "this Mac's provider connections; a server's are fleetProviderConnections"
  ),
  providerConnectionSetKey: localBecause(
    "this Mac's provider connections; a server's are fleetProviderConnections"
  ),
  onProviderConnectionsChanged: localBecause(
    "this Mac's provider connections; a server's are fleetProviderConnections"
  ),
  fleetProviderConnections: routed,
  fleetProviderConnectionAdd: routed,
  fleetProviderConnectionRename: routed,
  fleetProviderConnectionRemove: routed,
  fleetProviderConnectionSetKey: routed,
  // Lane C of the harness wave (PRDCT-4496): the models catalogue
  modelsCatalogRead: localBecause(
    "the window's own server's catalogue, this Mac's without one; a saved server's is fleetModelsCatalog"
  ),
  fleetModelsCatalog: routed,
  // Lane C of the harness wave (PRDCT-4496): a connection's usage line
  providerUsageRead: localBecause(
    "the window's own server's connection, this Mac's without one; a saved server's is fleetProviderUsage"
  ),
  fleetProviderUsage: routed
}
