/**
 * The triage contract, shared by main, preload and renderer (issue #227).
 *
 * "Debug Clave…" prepares a support conversation about THIS running app: the
 * process that answers, the server it runs on and who owns it, every window
 * and workspace, every terminal and chat session, without stopping, adopting
 * or rewriting any of them. Main collects a snapshot from read-only sources
 * (`src/main/triage/`), writes it beside a context file and a playbook in a
 * private bundle under the user-data directory, and hands the renderer what
 * it needs to start a support agent there or to copy the context elsewhere.
 *
 * What a snapshot never carries: credentials (server, MCP or account tokens),
 * environment values, process command lines, conversation content, provider
 * conversation ids, or the titles Clave generated from a first prompt. A tab
 * appears under the label its user gave it, or under its id.
 *
 * Both calls go over IPC and never through the server (`viaServer`): a
 * server that is gone or wedged is exactly what a triage must be able to
 * describe.
 */

export const TRIAGE_IPC = {
  /** Collect, write the bundle, answer `TriagePrepareResult`. */
  prepare: 'triage:prepare',
  /** Collect only, answer `TriageSnapshot`; nothing is written. */
  snapshot: 'triage:snapshot',
  /** Main → renderer: the menu's "Debug Clave…" asks the window to open triage. */
  open: 'menu:open-triage'
} as const

export const TRIAGE_SNAPSHOT_VERSION = 1

/** What one read-only source answered. A source that fails, times out or
 *  does not apply is said here and never fails the whole snapshot. `error`
 *  is already redacted. */
export type TriageSource<T> =
  | { status: 'ok'; value: T }
  | { status: 'timeout' | 'error' | 'unavailable'; error: string }

/** Which shell and which window asked. `instanceId` is minted once per main
 *  process, so two Clave instances (an installed app and a dev build, a
 *  Clave launched from a Clave tab) never read as one. */
export interface TriageOrigin {
  instanceId: string
  shellPid: number
  windowId: number | null
  windowKey: string | null
}

export interface TriageApp {
  name: string
  version: string
  packaged: boolean
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osRelease: string
  uptimeSec: number
  /** Only Clave's own mode flags (`--server=…`, `--test-…`, `--dev-…`); the
   *  rest of the command line is never collected. */
  flags: string[]
  paths: { userData: string; logs: string; crashDumps: string }
}

export interface TriageProcess {
  pid: number
  /** Electron's process type: Browser, Tab, GPU, Utility, … */
  type: string
  cpuPercent: number
  memoryKb: number
}

export type TriageServerMode = 'in-process' | 'separate' | 'attached' | 'unknown'
/** Who owns the server process: this shell's own process, a child this shell
 *  started, or somebody else (an attached server, possibly another machine). */
export type TriageServerOwnership = 'shell-process' | 'shell-child' | 'external' | 'unknown'

export interface TriageClient {
  id: string
  kind: string
  name: string
  pid: number | null
  registeredAt: number
}

export interface TriageServer {
  mode: TriageServerMode
  ownership: TriageServerOwnership
  /** The shell's discovery file said the server worked (`ok`), null when unread. */
  discoveryOk: boolean | null
  /** The failure the discovery file records, redacted. */
  discoveryError: string | null
  /** `http://127.0.0.1:<port>`; never a token. */
  origin: string | null
  /** The pid that wrote the discovery file: this shell, or a stale one. */
  discoveryShellPid: number | null
  serverPid: number | null
  serverAlive: boolean | null
  clientId: string | null
  /** The app's version for a server this shell runs or started; 'unknown'
   *  for an attached server, which does not report one. */
  version: string
  terminalProcess: {
    pid: number | null
    alive: boolean | null
    generation: number | null
    givenUp: boolean | null
  } | null
  /** The open health routes (no token): HTTP status, or null when unreachable. */
  health: { live: number | null; ready: number | null; readyBody: string | null }
  clients: TriageSource<TriageClient[]>
}

export interface TriageMcp {
  listening: boolean
  /** `http://127.0.0.1:<port>`; never a token. */
  origin: string | null
}

export interface TriageWorkspace {
  id: string
  name: string
  rootDir: string
}

export interface TriageWindow {
  id: number
  key: string | null
  workspaceId: string | null
  isPrimary: boolean
  focused: boolean
  /** The sessions main has bound to this window. */
  boundSessionIds: string[]
}

/** A session as the server runs it: terminal (`pty`) or chat (`events`). */
export interface TriageSession {
  id: string
  provider: string
  transport: 'pty' | 'events'
  state: string
  adapterId: string
  windowKey: string
  groupId: string | null
  cwd: string
  createdAt: number
  viewId: string | null
  /** The label its user gave the tab; null when the tab has none of its own. */
  userLabel: string | null
}

export interface TriageListedSession {
  id: string
  mode: string
  alive: boolean
  agentState: string | null
  groupId: string | null
  workspaceId: string | null
  accountId: string | null
}

export interface TriageListedGroup {
  id: string
  name: string
  sessionIds: string[]
  terminalCount: number
  /** The sessions serving the group's quick-launch terminals: shown by the
   *  group, never rows of their own. */
  terminalSessionIds: string[]
  workspaceId: string | null
  hasView: boolean
}

/** What one window's renderer says it shows. */
export type TriageWindowListing = { windowId: number } & TriageSource<{
  sessions: TriageListedSession[]
  groups: TriageListedGroup[]
}>

export type TriageRecordKind = 'claude' | 'codex' | 'antigravity' | 'pi' | 'terminal'

/** A session record on disk, read without the recovery path that prunes them. */
export interface TriageRecord {
  /** The record file's name without `.json`. */
  key: string
  id: string
  kind: TriageRecordKind
  transport: 'pty' | 'events' | null
  adapterId: string | null
  tmuxName: string | null
  windowKey: string | null
  workspaceId: string | null
  cwd: string
  /** What owns a hidden session (`group-terminal`, `session-view`, `toolbar`). */
  link: string | null
  startedAt: number | null
  userLabel: string | null
  /** A provider conversation is on record (its id is not collected). */
  hasProviderConversation: boolean
}

export interface TriageAgent {
  id: string
  installed: boolean
  currentVersion: string | null
  latestVersion: string | null
  lastCheckedAt: number | null
}

/** The disagreements between what runs and what the windows show. */
export interface TriageReconciliation {
  /** Shown in a window, unknown to the server (a renderer-only or lost tab). */
  uiOnly: string[]
  /** Run by the server, shown in no window. */
  serverOnly: string[]
  /** Run by the server for one window, shown in another. */
  windowMismatch: string[]
  /** A record on disk with no live session. */
  recordsWithoutSession: string[]
  /** A live `clave` tmux session with no record. */
  tmuxWithoutRecord: string[]
  /** False when a source this needs did not answer: the lists are partial. */
  complete: boolean
}

export interface TriageLimits {
  maxSessions: number
  maxRecords: number
  maxTmux: number
  sourceTimeoutMs: number
  /** Which lists were cut at their cap. */
  truncated: string[]
}

export interface TriageSnapshot {
  version: typeof TRIAGE_SNAPSHOT_VERSION
  generatedAt: string
  origin: TriageOrigin
  app: TriageApp
  processes: TriageSource<TriageProcess[]>
  server: TriageServer
  mcp: TriageMcp
  workspaces: TriageSource<TriageWorkspace[]>
  windows: TriageWindow[]
  sessions: TriageSource<TriageSession[]>
  windowListings: TriageWindowListing[]
  records: TriageSource<{ dir: string; total: number; items: TriageRecord[] }>
  tmux: TriageSource<{ live: string[] }>
  agents: TriageSource<TriageAgent[]>
  reconciliation: TriageReconciliation
  paths: {
    mainLog: string
    sessionRecords: string
    serverData: string | null
    /** Files holding credentials: the playbook forbids reading them. */
    neverRead: string[]
  }
  limits: TriageLimits
  warnings: string[]
}

export interface TriageBundle {
  /** `<userData>/triage/<stamp>/`, mode 0700; its files 0600. */
  dir: string
  snapshotPath: string
  contextPath: string
  promptPath: string
}

/** Where a support agent can run. `in-app` when this shell owns the server
 *  (in-process or its own child) and so shares the bundle's filesystem;
 *  `external-only` for an attached server, whose sessions may run on a host
 *  that cannot read the shell's private bundle: the UI then offers the
 *  same-machine commands and the copied context, never an in-app tab. */
export type TriageAgentLaunch = 'in-app' | 'external-only'

export interface TriagePrepareResult {
  generatedAt: string
  origin: TriageOrigin
  snapshot: TriageSnapshot
  /** The context file's text, for the dialog to show and copy. */
  contextMarkdown: string
  /** Null when the bundle could not be written (see `warnings`). */
  bundle: TriageBundle | null
  /** The one-line first prompt for a support agent; null without a bundle. */
  launchPrompt: string | null
  /** POSIX-shell-safe commands to run the agent in a terminal on this
   *  machine; null without a bundle. */
  externalCommands: { claude: string; codex: string } | null
  agentLaunch: TriageAgentLaunch
  summary: {
    mode: TriageServerMode
    serverOk: boolean
    windows: number
    sessions: number | null
    problems: number
  }
  warnings: string[]
}
