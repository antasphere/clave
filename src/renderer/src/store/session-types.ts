/**
 * Every skin the app ships, as a runtime list — the union is derived from it
 * rather than written beside it. A theme is four things that live in four files
 * (this list, a `[data-theme]` block in main.css, an xterm palette, a swatch in
 * the Appearance pane) and none of them fails loudly when it lags: a missing CSS
 * block inherits the dark theme's palette and simply looks wrong. Deriving the
 * union means the palette table's `Record<Theme, ...>` is a type error the
 * moment a name is added here, and `theme-palettes.test.ts` walks this list to
 * hold the other two honest.
 */
export const THEMES = ['dark', 'charcoal', 'light', 'coffee'] as const

export type Theme = (typeof THEMES)[number]

/**
 * How heavily a tree draws the hairlines between its rows — the Files tab, the
 * git panel's repo tree, the changed files inside a repo. One setting for all
 * of them: a multiplier on whatever alpha the current theme picked for
 * `--rule-color`, so a theme still says what colour its hairline is and this
 * says how much of it to draw. `off` removes the rules from every tree at once.
 *
 * Ids are stored, not numbers: the multipliers are a design call and can be
 * retuned without stranding what is in a user's localStorage.
 */
export const TREE_RULE_INTENSITIES = [
  { id: 'off', label: 'Off', multiplier: 0 },
  { id: 'soft', label: 'Soft', multiplier: 0.55 },
  { id: 'normal', label: 'Normal', multiplier: 1 },
  { id: 'strong', label: 'Strong', multiplier: 1.9 }
] as const

export type TreeRuleIntensity = (typeof TREE_RULE_INTENSITIES)[number]['id']

/** The multiplier a level draws at; unknown ids fall back to the default. */
export function treeRuleMultiplier(intensity: TreeRuleIntensity): number {
  return TREE_RULE_INTENSITIES.find((i) => i.id === intensity)?.multiplier ?? 1
}

/**
 * How tight the app's chrome is drawn: one of five presets, written on the
 * root element as `data-density` and resolved in
 * `packages/ui/src/density.css`. Each preset is a table of literal values, not
 * a multiplier — `compact` is the spec as set on 2026-09-21 and `comfortable`
 * the chrome as tuned before it, both exactly, and no single ratio maps one
 * onto the other. The three others are derived from those two.
 *
 * Ids are stored, not numbers, so a preset can be retuned without stranding
 * what is already in a user's localStorage.
 */
export const DENSITY_LEVELS = [
  { id: 'tight', label: 'Tight' },
  { id: 'compact', label: 'Compact' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'spacious', label: 'Spacious' }
] as const

export type Density = (typeof DENSITY_LEVELS)[number]['id']

/** The preset the app opens at, and what an unknown id falls back to. */
export const DEFAULT_DENSITY: Density = 'comfortable'

/** Where the preset is saved. A new key, because the old one (`clave-density`)
 *  stored the 2026-09-21 multiplier stops, and its `compact` meant 0.875. */
export const DENSITY_STORAGE_KEY = 'clave-density-preset'
export const LEGACY_DENSITY_STORAGE_KEY = 'clave-density'

/** A stop of the old multiplier slider → the preset that looks like it.
 *  `regular` (scale 1) IS `compact`: the same spec, byte for byte. */
const LEGACY_DENSITY: Record<string, Density> = {
  compact: 'tight',
  snug: 'tight',
  regular: 'compact',
  relaxed: 'balanced',
  spacious: 'comfortable'
}

/**
 * The preset a saved string names, CHECKED against the table rather than cast
 * to it: the value ends up as an attribute a stylesheet matches on, and an id
 * no block matches silently draws the Compact spec. `legacy` is the old
 * multiplier key, read only when nothing was saved under the new one.
 */
export function resolveDensity(saved: string | null, legacy: string | null = null): Density {
  if (DENSITY_LEVELS.some((level) => level.id === saved)) return saved as Density
  if (
    saved === null &&
    legacy !== null &&
    Object.prototype.hasOwnProperty.call(LEGACY_DENSITY, legacy)
  ) {
    return LEGACY_DENSITY[legacy]
  }
  return DEFAULT_DENSITY
}

/** The preset's position on the slider; an unknown id sits on the default. */
export function densityIndex(density: Density): number {
  const i = DENSITY_LEVELS.findIndex((d) => d.id === density)
  return i === -1 ? DENSITY_LEVELS.findIndex((d) => d.id === DEFAULT_DENSITY) : i
}

/**
 * Appearance → Text size: px added to the chrome's label sizes on top of the
 * density preset, written as `--ui-text-offset`. Additive, so the presets'
 * own sizes (12px bar labels at Comfortable, 13px at Compact) keep their
 * relation to each other at every step. Capped at +2: the rows keep their
 * height, and a Compact 24px control holds nothing larger than ~15px text.
 */
export const TEXT_SIZE_LEVELS = [
  { id: 'smaller', label: 'Smaller', offset: -1 },
  { id: 'default', label: 'Default', offset: 0 },
  { id: 'larger', label: 'Larger', offset: 1 },
  { id: 'largest', label: 'Largest', offset: 2 }
] as const

export type TextSize = (typeof TEXT_SIZE_LEVELS)[number]['id']

export const DEFAULT_TEXT_SIZE: TextSize = 'default'

export function resolveTextSize(saved: string | null): TextSize {
  return TEXT_SIZE_LEVELS.some((level) => level.id === saved)
    ? (saved as TextSize)
    : DEFAULT_TEXT_SIZE
}

/** The px a text size adds; unknown ids add nothing. */
export function textSizeOffset(size: TextSize): number {
  return TEXT_SIZE_LEVELS.find((level) => level.id === size)?.offset ?? 0
}

/**
 * Which folder the side panel hangs from — the Files tab, the Git tab, and the
 * root chip that switches between them. `session` is the focused tab's own
 * folder, `group` the folder its group was declared on, `workspace` the
 * workspace root. Ordered as the chip's menu lists them, widest first.
 *
 * One table rather than a union with three maps beside it: the glyph, the
 * label and the phrase the tooltips read are all per-rung copy, and a rung
 * added with only some of them renders blank rather than failing.
 */
export const PANEL_ROOTS = [
  { id: 'workspace', label: 'Workspace', glyph: 'W', home: 'the workspace root' },
  { id: 'group', label: 'Group', glyph: 'G', home: "the group's folder" },
  { id: 'session', label: 'Session', glyph: 'S', home: "the session's folder" }
] as const

export type PanelScope = (typeof PANEL_ROOTS)[number]['id']

/**
 * The order the panel tries the rungs in, given the preferred root: the
 * preference first, then the rest, narrowest first. Which rung a tab actually
 * lands on is a ladder rather than a fixed choice — a tab outside any group
 * has no group folder, and a window with no tab focused has neither that nor a
 * session folder, so a fixed rung would leave the panel pointed at nothing.
 */
export function panelRootLadder(preferred: PanelScope): PanelScope[] {
  const rest: PanelScope[] = ['session', 'group', 'workspace']
  return [preferred, ...rest.filter((s) => s !== preferred)]
}

/**
 * The themes that paint on a dark ground. The one place that answers it.
 *
 * Every `theme === 'dark'` in the app was really a light/dark test written when
 * `dark` was the only dark theme, and each one FAILED SILENTLY the moment a
 * second one existed: charcoal would have been handed github-light source
 * highlighting and the light xterm palette, on a charcoal surface, with nothing
 * throwing. A theme is dark if it is in here, and adding the next one is one
 * edit rather than a hunt.
 */
export const DARK_THEMES = ['dark', 'charcoal'] as const satisfies readonly Theme[]

export function isDarkTheme(theme: Theme): boolean {
  return (DARK_THEMES as readonly string[]).includes(theme)
}

export type AppIcon = 'dark' | 'light' | 'claude'

export type ActivityStatus = 'active' | 'idle' | 'ended'

/**
 * Deterministic Claude Code run state, sourced from CC lifecycle hooks (see
 * main/agent-state-manager.ts). Drives the sidebar tab status visuals for Claude
 * sessions only — other providers stay neutral. `ended` is derived from `alive`
 * at render time, so the hook-fed values are idle/working/blocked/done.
 */
export type AgentRunState = 'idle' | 'working' | 'blocked' | 'done'

export type SessionType = 'local' | 'remote-terminal' | 'remote-claude' | 'agent'

export type GroupTerminalColor =
  | 'black'
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'yellow'
  | 'pink'
  | 'red'
  | (string & {})

export const GROUP_TERMINAL_COLORS: GroupTerminalColor[] = [
  'black',
  'green',
  'teal',
  'blue',
  'purple',
  'yellow',
  'pink',
  'red'
]

export const TERMINAL_COLOR_VALUES: Record<string, string> = {
  black: '#95979c',
  green: '#4cb782',
  teal: '#53b7c5',
  blue: '#5e6ad2',
  purple: '#8b95a8',
  yellow: '#e8b931',
  pink: '#db8b4e',
  red: '#d45461'
}

/** Resolve a color name or custom hex string to its hex value */
export function resolveColorHex(color: GroupTerminalColor | null | undefined): string | undefined {
  if (!color) return undefined
  if (color in TERMINAL_COLOR_VALUES) return TERMINAL_COLOR_VALUES[color]
  if (color.startsWith('#')) return color
  return undefined
}

export type GroupTerminalIcon =
  | 'terminal'
  | 'fire'
  | 'bolt'
  | 'rocket'
  | 'eye'
  | 'globe'
  | 'cube'
  | 'heart'
  | 'star'
  | 'user'
  | 'shield'
  | 'wrench'
  | 'beaker'
  | 'cpu'
  | 'signal'
  | 'bug'
  | 'sparkles'
  | 'cloud'

export const GROUP_TERMINAL_ICONS: GroupTerminalIcon[] = [
  'terminal',
  'fire',
  'bolt',
  'rocket',
  'eye',
  'globe',
  'cube',
  'heart',
  'star',
  'user',
  'shield',
  'wrench',
  'beaker',
  'cpu',
  'signal',
  'bug',
  'sparkles',
  'cloud'
]

export interface GroupTerminalConfig {
  id: string
  command: string
  commandMode: 'prefill' | 'auto'
  color: GroupTerminalColor
  icon?: GroupTerminalIcon
  cwd?: string | null
  autoLaunchLocalhost?: boolean
  /** Declared dev-server URL (e.g. "http://localhost:3000"). On toolbar buttons
   *  this enables probe-first "ensure running, then open" (see use-server-button.ts).
   *  On a sidebar group terminal it is what `groupView` binds. */
  serverUrl?: string
  /** This terminal's `serverUrl` is the group's web view: the page the user sees
   *  when clicking the group, with this terminal as its start action. Declared in
   *  a `.clave` file (bound at launch) or by `clave_add_group_terminal`; carried
   *  on the live config so a pin resync never drops it from the file. */
  groupView?: boolean
  sessionId: string | null
}

export type ServerStatus = 'running' | 'stopped' | 'starting' | null

export interface Session {
  id: string
  cwd: string
  folderName: string
  name: string
  alive: boolean
  activityStatus: ActivityStatus
  /** Deterministic Claude run state from CC hooks; undefined until first signal. */
  agentState?: AgentRunState
  /** How many background shells/subagents a chat session left running past its
   *  turn, from the provider's own list. Runtime only; absent means none. */
  backgroundTasks?: number
  promptWaiting: string | null
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  /** Pi mode. Optional so session records written before Pi remain valid. */
  piMode?: boolean
  /** Claude session launched via the `claude agents` subcommand. */
  claudeAgentsMode?: boolean
  dangerousMode: boolean
  /** Model this session was launched on (claude/codex modes), so Duplicate and
   *  restore keep it. Undefined = the CLI's default; /model inside the session
   *  can diverge from it afterwards without Clave knowing. */
  model?: string
  /** Session id of the tab whose agent opened this one via clave_open_session,
   *  so the child can target "parent" in clave_send_to_session /
   *  clave_read_session. Session-lifetime only: not persisted to the tmux
   *  sidecar, so the link is gone after an app restart. */
  spawnedBy?: string
  claudeSessionId: string | null
  piSessionId?: string | null
  launchProfileId?: string
  piProvider?: string
  piThinking?: import('../../../shared/agent-launch').PiThinkingLevel
  /** Claude account/profile this session runs under (issue #22). Undefined =
   *  the Default profile. `claudeProfileLabel` drives the session-header badge. */
  claudeProfileId?: string
  claudeProfileLabel?: string
  claudeConfigDir?: string
  /** Codex account this session runs on (ADR 0002). Undefined = the Default,
   *  the machine's own `~/.codex`. `codexAccountLabel` drives the badge. */
  codexAccountId?: string
  codexAccountLabel?: string
  /** Bumped by a restart on another account: the pane remounts on it, so
   *  the terminal reconnects to the new process under the same id. */
  restartEpoch?: number
  /** Pinned to its account (ADR 0002): never moved by the policy, never
   *  proposed a move; the menu can still switch it by hand. Session-lifetime. */
  accountPinned?: boolean
  /** This session's own switching mode, over the workspace's. */
  accountSwitchMode?: 'propose' | 'automatic'
  /** The move the policy proposes (or, in automatic mode, will make once the
   *  agent is idle): the account to go to. Null = nothing proposed. */
  accountProposal?: { accountId: string; label: string; reason: 'limit' | 'reported' } | null
  /** The proposal the user dismissed, by account, so it is not re-raised
   *  until the account changes. */
  accountProposalDismissed?: string | null
  /** The CLI itself reported the account's limit (a chat stream event). */
  limitReported?: boolean
  /** True between the kill and the respawn of an account switch, so the
   *  exit is not announced as the session ending. */
  restarting?: boolean
  /** One-shot prompt this session was launched with (agent modes only), so
   *  Duplicate can re-prime the clone. Not persisted to the tmux sidecar, so a
   *  session re-adopted after an app restart loses it (the resumed conversation
   *  already contains the prompt + response) — an accepted, documented edge. */
  initialPrompt?: string
  locationId?: string
  shellId?: string
  sessionType: SessionType
  agentId?: string
  detectedUrl: string | null
  serverStatus: ServerStatus
  serverCommand: string | null
  /** Attached web view (see SessionViewConfig). Shown in the main pane via the
   *  row's dashboard icon; the row click itself still shows the terminal.
   *  Persisted in the session's record (main process) so it survives restart. */
  view?: SessionViewConfig | null
  hasUnseenActivity: boolean
  /** Name of another tab whose agent injected a message into this one via
   *  clave_send_to_session, set on delivery and cleared when the tab is viewed.
   *  Drives a distinct sidebar marker so a cross-tab message is never silent. */
  injectedFrom?: string | null
  userRenamed: boolean
  planFilePath: string | null
  /** Workspace this session belongs to, stamped at spawn from the then-active
   *  workspace (or inherited: duplicate/resume take the source session's, pin
   *  launches the pin's, MCP spawns the caller's). Persisted in the session
   *  record so it survives restarts. Undefined = unstamped → visible in every
   *  workspace (no-workspace mode and the legacy safety net). */
  workspaceId?: string
}

/** A web page attached to a group: clicking the group shows this rendered page
 *  in the main pane instead of the tiled session mosaic. `url` is an http(s)
 *  URL (a dev server, a workstream dashboard) or an absolute .html file path
 *  (rendered via the clave-preview protocol). `terminalId` links the group
 *  terminal that serves the URL, powering the down-state "start server" action. */
export interface GroupViewConfig {
  url: string
  title?: string
  terminalId?: string | null
}

/** A session's attached web view — the fast-lane case: a workstream dashboard
 *  or any served page belonging to ONE tab, with no group around it. The
 *  serving process is a hidden linked session (`serverSessionId`), respawnable
 *  from `command`/`cwd` when the probe finds the page down — so the view
 *  carries its own start action exactly like a group view's linked terminal. */
export interface SessionViewConfig {
  url: string
  title?: string
  /** Command that serves `url`; the start action when the probe says down. */
  command?: string
  /** Working directory for `command` (defaults to the owning session's cwd). */
  cwd?: string
  /** The hidden serving session, when one is running. Never persisted — a
   *  restart leaves it null and the start action respawns from `command`. */
  serverSessionId?: string | null
}

export interface SessionGroup {
  id: string
  name: string
  sessionIds: string[]
  collapsed: boolean
  cwd: string | null
  terminals: GroupTerminalConfig[]
  /** Default prompt new sessions launched from this group's `+` inherit.
   *  Set from the group's `.clave` entry when the group was stamped out of a
   *  pin, or by an agent through `clave_create_group`. There is no UI to edit it
   *  on a live group. Null/absent = the `+` launches with no prompt, exactly
   *  like the sidebar's own agent button. */
  prompt?: string | null
  /** The `+` starts its session at the WORKSPACE ROOT instead of the group's
   *  `cwd`. Stamped from the `.clave` entry session that gave this group its
   *  brief (`rootSession: true`) — the `+` reproduces that session, so a tab
   *  opened an hour later lands where the group's own tabs did. `cwd` still
   *  names the project dir the prompt's @-tokens resolve against. */
  rootSession?: boolean
  color?: GroupTerminalColor | null
  /** Attached web view — persists with the group (serialized whole). */
  view?: GroupViewConfig | null
  /** Workspace this group belongs to (see Session.workspaceId). Persists via
   *  sidebar-layout.json since groups are serialized whole. */
  workspaceId?: string
}

export interface FileTabDiffInfo {
  type: 'working' | 'commit'
  cwd: string
  file: string
  staged: boolean
  fileStatus: string
  hash: string | null
}

export interface FileTab {
  id: string
  filePath: string
  name: string
  kind?: 'file' | 'diff'
  diff?: FileTabDiffInfo
  /** Requested view mode for .html files (e.g. an agent opening one rendered
   *  via clave_open_file). Undefined = the file kind's default. */
  view?: 'rendered' | 'source'
}

export type ActiveView = 'terminals' | 'settings' | 'agents' | 'extensions'

export type SettingsSection =
  | 'plugins'
  | 'general'
  | 'accounts'
  | 'agents'
  | 'appearance'
  | 'keymaps'
  | 'updates'
  | 'usage'

export type ExtensionsSection = 'marketplaces' | 'mcp'

export interface PinnedGroupSession {
  cwd: string
  name: string
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  piMode?: boolean
  claudeAgentsMode?: boolean
  dangerousMode: boolean
  /** One-shot initial prompt auto-submitted to the agent on launch. Agent modes
   *  only (claude/antigravity/codex) — ignored for plain terminals and the
   *  `claude agents` subcommand. May contain @root_path / @project_path /
   *  @project_abs tokens (substituted at spawn when the pin knows its workspace root). */
  prompt?: string
  /** Spawn the session at the workspace root (the dir the discovering workspace
   *  was rooted at) instead of at `cwd`. `cwd` still defines the project dir that
   *  feeds the prompt path tokens. No-op if the pin has no workspaceRoot. */
  rootSession?: boolean
  /** The account (subscription) the session starts on, by LABEL as set in
   *  Settings → Accounts, or `any` for the pool's pick (ADR 0002). Labels,
   *  not ids: a `.clave` is shared between machines. Claude and Codex
   *  sessions only. An unknown label falls back to the Default with a note. */
  account?: string
}

export interface PinnedGroupTerminal {
  command: string
  commandMode: 'prefill' | 'auto'
  color: GroupTerminalColor
  icon?: GroupTerminalIcon
  cwd?: string | null
  autoLaunchLocalhost?: boolean
  persistent?: boolean
  /** Declared dev-server URL. Turns a toolbar terminal into a server button:
   *  click = probe the URL, open it if reachable, otherwise start the command
   *  and open on URL detection. Implies `persistent` for toolbar buttons. */
  serverUrl?: string
  /** In a sidebar group: bind `serverUrl` as the group's web view when the group
   *  launches (requires `serverUrl` — a view needs a page to show). */
  groupView?: boolean
}

export interface PinnedGroup {
  id: string
  name: string
  cwd: string | null
  color: GroupTerminalColor | null
  /** Group-level default prompt (`.clave` `prompt`). Inherited by sessions the
   *  live group's `+` launches; a session's own `prompt` still wins for that
   *  session. Carries the same @-tokens, substituted at spawn. */
  prompt?: string | null
  /** Group-level web view (`.clave` `view`): a page that needs no process — an
   *  http(s) URL, or an absolute .html path (resolved from the file at read).
   *  A terminal's `groupView` wins over it; see resolveDeclaredGroupView. */
  view?: string | null
  sessions: PinnedGroupSession[]
  terminals: PinnedGroupTerminal[]
  createdAt: number
  filePath?: string | null
  rootDir?: string | null // Root dir for resolving paths (null = file's parent dir)
  workspaceRoot?: string | null // Absolute root of the workspace that discovered this pin; feeds rootSession spawn + prompt path tokens. null = standalone import.
  groupIndex?: number // Position in multi-group .clave file (0-based)
  toolbar?: boolean // Show this group's terminals as toolbar quick-actions
  logo?: string | null // Absolute path to logo image
  category?: string | null // Category label for organizing pins in the sidebar
  discoveredBy?: string | null // filePath of workspace profile that auto-discovered this pin
  /** Workspace this pin belongs to. All registered workspaces' pins live in the
   *  store simultaneously; the UI filters by the active workspace. null =
   *  unscoped (no-workspace mode), visible everywhere until a workspace exists. */
  workspaceId?: string | null
  // Runtime state (not persisted)
  activeGroupId: string | null
  visible: boolean
}
