// ── Extensions inventory — normalized model for a CLI agent's installed
// plugins, marketplaces, skills, agents, commands, and MCP servers.
//
// v1 reads Claude Code only. The shapes are deliberately provider-neutral so
// Codex and Antigravity readers can populate the same inventory later (they would
// mostly contribute `mcpServers`, plus Codex `skills`). Everything is read-only.

/** Which CLI a snapshot belongs to. v1 only ever produces 'claude'. */
export type ExtensionsProvider = 'claude' | 'codex' | 'antigravity'

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown'

/** Where a capability comes from, relative to the config dir being inspected. */
export type ExtensionScope = 'user' | 'project' | 'plugin'

export interface McpServerInfo {
  name: string
  transport: McpTransport
  scope: ExtensionScope
  /** stdio: the spawned command. http/sse: undefined (see `url`). */
  command?: string
  args?: string[]
  /** http/sse transports only. */
  url?: string
  /** Env var KEYS only — values are never read, to avoid surfacing secrets. */
  envKeys?: string[]
  /** Plugin scope: the owning plugin id ("<plugin>@<marketplace>"). */
  source?: string
}

export interface SkillInfo {
  name: string
  description?: string
  version?: string
  allowedTools?: string[]
  /** Owning plugin id, or 'user' for ~/.claude/skills. */
  source: string
  scope: ExtensionScope
  /** Absolute path to the SKILL.md. */
  path: string
}

export interface AgentInfo {
  name: string
  description?: string
  model?: string
  /** Owning plugin id, or 'user' for ~/.claude/agents. */
  source: string
  scope: ExtensionScope
  path: string
}

export interface CommandInfo {
  name: string
  description?: string
  /** Owning plugin id, or 'user' for ~/.claude/commands. */
  source: string
  scope: ExtensionScope
  path: string
}

export interface PluginInfo {
  /** "<plugin>@<marketplace>" — the key from installed_plugins.json. */
  id: string
  name: string
  marketplace: string
  description?: string
  version: string
  author?: string
  keywords?: string[]
  scope: 'user' | 'local'
  /** Whether the plugin is enabled (loaded into sessions). Disabled plugins
   *  stay installed but are skipped at session start. Default true. */
  enabled: boolean
  installPath: string
  installedAt?: string
  lastUpdated?: string
  counts: { skills: number; agents: number; commands: number; mcpServers: number }
  skills: SkillInfo[]
  agents: AgentInfo[]
  commands: CommandInfo[]
  mcpServers: McpServerInfo[]
}

export interface MarketplaceInfo {
  name: string
  sourceType: 'github' | 'git' | 'directory' | 'unknown'
  /** Human-readable source: "owner/repo", a git URL, or a directory path. */
  sourceLabel: string
  installLocation: string
  lastUpdated?: string
  autoUpdate?: boolean
  /** Plugin names this marketplace offers (from its marketplace.json). */
  offeredPlugins: string[]
  /** How many of the offered plugins are currently installed. */
  installedCount: number
}

/** A complete snapshot for one provider + config dir. */
export interface ExtensionsInventory {
  provider: ExtensionsProvider
  /** The base config dir actually read (e.g. ~/.claude or a custom profile dir). */
  configDir: string
  marketplaces: MarketplaceInfo[]
  plugins: PluginInfo[]
  /** User-level (non-plugin) capabilities under the config dir. */
  userSkills: SkillInfo[]
  userAgents: AgentInfo[]
  userCommands: CommandInfo[]
  /** User-scope + every plugin's bundled MCP servers, merged. */
  mcpServers: McpServerInfo[]
  /** Non-fatal read errors worth surfacing in the UI. */
  warnings: string[]
}

/** Install scope accepted by `claude plugin` mutating commands. */
export type MutationScope = 'user' | 'project' | 'local'

/**
 * Result of a mutating extensions operation (install/uninstall/enable/disable,
 * marketplace add/remove). Mutators never throw across IPC — failures come back
 * as `{ ok: false, message }` so the renderer can surface CLI stderr inline.
 */
export interface MutationResult {
  ok: boolean
  /** Human-readable outcome: a short success note, or the CLI's error output. */
  message: string
}
