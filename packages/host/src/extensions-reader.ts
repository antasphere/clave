import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import type {
  ExtensionsInventory,
  PluginInfo,
  MarketplaceInfo,
  SkillInfo,
  AgentInfo,
  CommandInfo,
  McpServerInfo,
  McpTransport,
  ExtensionScope
} from '../../shared/src/extensions-types'

// ── Claude Code config layout ────────────────────────────────────────────────
//
// Everything an inventory needs lives under a single base dir:
//   <base>/plugins/known_marketplaces.json   — marketplace registry
//   <base>/plugins/installed_plugins.json     — installed plugins (v2)
//   <base>/plugins/cache/<mkt>/<plugin>/<ver>/ — plugin files
//   <base>/plugins/marketplaces/<name>/        — cloned marketplace repos
//   <base>/skills, <base>/agents, <base>/commands — user-level capabilities
//   <base>/.claude.json (or ~/.claude.json)    — user-scope mcpServers
//
// The default base is ~/.claude. A custom profile sets CLAUDE_CONFIG_DIR to a
// different dir, which relocates the whole tree — so the reader takes the base
// dir as a parameter and never hardcodes ~/.claude below this line.

/** Resolve the base config dir: a profile's configDir, or the default ~/.claude. */
function resolveBaseDir(configDir?: string): string {
  const trimmed = configDir?.trim()
  if (trimmed) return trimmed
  return path.join(homedir(), '.claude')
}

// ── Minimal YAML frontmatter parser ──────────────────────────────────────────
// SKILL.md / agent / command files use a small, predictable subset: `key: value`
// scalars, `key: |` block scalars (multi-line description), and `key:` followed
// by `- item` lists. We parse just enough — no external dependency.

interface Frontmatter {
  [key: string]: string | string[]
}

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith('---')) return {}
  const end = content.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = content.slice(3, end).replace(/^\n/, '')
  const lines = block.split('\n')
  const out: Frontmatter = {}

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    const rest = m[2]

    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      // Block scalar: collect deeper-indented lines.
      const collected: string[] = []
      i++
      while (i < lines.length && (lines[i].trim() === '' || /^\s+/.test(lines[i]))) {
        collected.push(lines[i].replace(/^\s{1,4}/, ''))
        i++
      }
      out[key] = collected.join(' ').trim()
      continue
    }

    if (rest === '') {
      // Possibly a list: subsequent `- item` lines.
      const items: string[] = []
      let j = i + 1
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(
          lines[j]
            .replace(/^\s*-\s+/, '')
            .trim()
            .replace(/^["']|["']$/g, '')
        )
        j++
      }
      if (items.length > 0) {
        out[key] = items
        i = j
        continue
      }
      out[key] = ''
      i++
      continue
    }

    // Inline list: `[a, b, c]`
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      i++
      continue
    }

    out[key] = rest.trim().replace(/^["']|["']$/g, '')
    i++
  }
  return out
}

function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v.join(', ') : v
}

function asList(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v : [v]
}

// ── Safe filesystem helpers ──────────────────────────────────────────────────

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return null
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
}

function listMd(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name)
  } catch {
    return []
  }
}

function readFrontmatter(file: string): Frontmatter {
  try {
    return parseFrontmatter(fs.readFileSync(file, 'utf-8'))
  } catch {
    return {}
  }
}

// ── Capability readers ───────────────────────────────────────────────────────

/** Read every skill under a `skills/` dir (each a folder with a SKILL.md). */
function readSkills(skillsDir: string, source: string, scope: ExtensionScope): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const name of listDirs(skillsDir)) {
    const skillMd = path.join(skillsDir, name, 'SKILL.md')
    if (!fs.existsSync(skillMd)) continue
    const fm = readFrontmatter(skillMd)
    out.push({
      name: asString(fm.name) || name,
      description: asString(fm.description),
      version: asString(fm.version),
      allowedTools: asList(fm['allowed-tools']),
      source,
      scope,
      path: skillMd
    })
  }
  return out
}

function readAgents(agentsDir: string, source: string, scope: ExtensionScope): AgentInfo[] {
  return listMd(agentsDir).map((file) => {
    const full = path.join(agentsDir, file)
    const fm = readFrontmatter(full)
    return {
      name: asString(fm.name) || file.replace(/\.md$/, ''),
      description: asString(fm.description),
      model: asString(fm.model),
      source,
      scope,
      path: full
    }
  })
}

function readCommands(commandsDir: string, source: string, scope: ExtensionScope): CommandInfo[] {
  return listMd(commandsDir).map((file) => {
    const full = path.join(commandsDir, file)
    const fm = readFrontmatter(full)
    return {
      name: asString(fm.name) || file.replace(/\.md$/, ''),
      description: asString(fm.description),
      source,
      scope,
      path: full
    }
  })
}

interface RawMcpServer {
  type?: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

function normalizeMcp(
  name: string,
  raw: RawMcpServer,
  scope: ExtensionScope,
  source?: string
): McpServerInfo {
  const type = (raw.type || '').toLowerCase()
  let transport: McpTransport = 'unknown'
  if (type === 'stdio' || (!type && raw.command)) transport = 'stdio'
  else if (type === 'http') transport = 'http'
  else if (type === 'sse') transport = 'sse'
  else if (raw.url) transport = 'http'

  return {
    name,
    transport,
    scope,
    command: raw.command,
    args: raw.args,
    url: raw.url,
    envKeys: raw.env ? Object.keys(raw.env) : undefined,
    source
  }
}

function readMcpFile(file: string, scope: ExtensionScope, source?: string): McpServerInfo[] {
  const data = readJson<{ mcpServers?: Record<string, RawMcpServer> }>(file)
  if (!data?.mcpServers) return []
  return Object.entries(data.mcpServers).map(([name, raw]) =>
    normalizeMcp(name, raw, scope, source)
  )
}

// ── Registry shapes (as stored on disk) ──────────────────────────────────────

interface InstalledPluginRecord {
  scope?: 'user' | 'local'
  installPath?: string
  projectPath?: string
  version?: string
  installedAt?: string
  lastUpdated?: string
}

interface KnownMarketplace {
  source?: { source?: string; repo?: string; url?: string; path?: string }
  installLocation?: string
  lastUpdated?: string
  autoUpdate?: boolean
}

interface MarketplaceManifest {
  plugins?: { name?: string }[]
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Build a read-only Claude Code extensions inventory for a config dir.
 * `configDir` empty/undefined → the default ~/.claude. Never throws: read
 * failures degrade to empty sections plus a `warnings` entry.
 */
export function readClaudeInventory(configDir?: string): ExtensionsInventory {
  const base = resolveBaseDir(configDir)
  const warnings: string[] = []
  const pluginsRoot = path.join(base, 'plugins')

  // ── Plugins ──
  const installed =
    readJson<{ plugins?: Record<string, InstalledPluginRecord[]> }>(
      path.join(pluginsRoot, 'installed_plugins.json')
    )?.plugins ?? {}

  // Enabled/disabled state lives in <base>/settings.json under `enabledPlugins`
  // (a map of "<plugin>@<marketplace>" → boolean). A plugin absent from the map
  // is enabled by default; only an explicit `false` disables it.
  const enabledPlugins =
    readJson<{ enabledPlugins?: Record<string, boolean> }>(path.join(base, 'settings.json'))
      ?.enabledPlugins ?? {}

  const plugins: PluginInfo[] = []
  const allMcp: McpServerInfo[] = []

  for (const [id, records] of Object.entries(installed)) {
    const record = records?.[0]
    if (!record?.installPath) continue
    const [pluginName, marketplace] = id.split('@')
    const installPath = record.installPath

    const manifest =
      readJson<{ description?: string; author?: { name?: string } | string; keywords?: string[] }>(
        path.join(installPath, '.claude-plugin', 'plugin.json')
      ) ?? {}

    const skills = readSkills(path.join(installPath, 'skills'), id, 'plugin')
    const agents = readAgents(path.join(installPath, 'agents'), id, 'plugin')
    const commands = readCommands(path.join(installPath, 'commands'), id, 'plugin')
    const mcpServers = readMcpFile(path.join(installPath, '.mcp.json'), 'plugin', id)
    allMcp.push(...mcpServers)

    plugins.push({
      id,
      name: pluginName || id,
      marketplace: marketplace || 'unknown',
      description: manifest.description,
      version: record.version || 'unknown',
      author: typeof manifest.author === 'string' ? manifest.author : manifest.author?.name,
      keywords: manifest.keywords,
      scope: record.scope || 'user',
      enabled: enabledPlugins[id] !== false,
      installPath,
      installedAt: record.installedAt,
      lastUpdated: record.lastUpdated,
      counts: {
        skills: skills.length,
        agents: agents.length,
        commands: commands.length,
        mcpServers: mcpServers.length
      },
      skills,
      agents,
      commands,
      mcpServers
    })
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))

  // ── Marketplaces ──
  const known =
    readJson<Record<string, KnownMarketplace>>(path.join(pluginsRoot, 'known_marketplaces.json')) ??
    {}
  const installedPluginNames = new Set(plugins.map((p) => p.name))

  const marketplaces: MarketplaceInfo[] = Object.entries(known).map(([name, m]) => {
    const src = m.source ?? {}
    let sourceType: MarketplaceInfo['sourceType'] = 'unknown'
    let sourceLabel = ''
    if (src.source === 'github' && src.repo) {
      sourceType = 'github'
      sourceLabel = src.repo
    } else if (src.source === 'git' && src.url) {
      sourceType = 'git'
      sourceLabel = src.url
    } else if (src.source === 'directory' && src.path) {
      sourceType = 'directory'
      sourceLabel = src.path
    } else {
      sourceLabel = src.repo || src.url || src.path || ''
    }

    const manifest = m.installLocation
      ? readJson<MarketplaceManifest>(
          path.join(m.installLocation, '.claude-plugin', 'marketplace.json')
        )
      : null
    const offeredPlugins = (manifest?.plugins ?? [])
      .map((p) => p.name)
      .filter((n): n is string => !!n)

    return {
      name,
      sourceType,
      sourceLabel,
      installLocation: m.installLocation || '',
      lastUpdated: m.lastUpdated,
      autoUpdate: m.autoUpdate,
      offeredPlugins,
      installedCount: offeredPlugins.filter((n) => installedPluginNames.has(n)).length
    }
  })
  marketplaces.sort((a, b) => a.name.localeCompare(b.name))

  // ── User-level (non-plugin) capabilities ──
  const userSkills = readSkills(path.join(base, 'skills'), 'user', 'user')
  const userAgents = readAgents(path.join(base, 'agents'), 'user', 'user')
  const userCommands = readCommands(path.join(base, 'commands'), 'user', 'user')

  // ── User-scope MCP servers ──
  // With CLAUDE_CONFIG_DIR set, the main config relocates to <base>/.claude.json;
  // the default install keeps it at ~/.claude.json (outside ~/.claude). Try the
  // in-dir location first, then fall back to the home-root file.
  let userMcp = readMcpFile(path.join(base, '.claude.json'), 'user')
  if (userMcp.length === 0) {
    const homeJson = path.join(homedir(), '.claude.json')
    if (fs.existsSync(homeJson)) userMcp = readMcpFile(homeJson, 'user')
  }
  allMcp.push(...userMcp)

  if (!fs.existsSync(pluginsRoot) && userSkills.length === 0 && userMcp.length === 0) {
    warnings.push(`No Claude config found at ${base}. This profile may be signed out.`)
  }

  return {
    provider: 'claude',
    configDir: base,
    marketplaces,
    plugins,
    userSkills,
    userAgents,
    userCommands,
    mcpServers: allMcp,
    warnings
  }
}
