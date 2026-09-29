/**
 * The pure half of the agent updater: where a CLI came from, which version a
 * string names, who upgrades it and where its latest release is read. No
 * process, no network, no file system — `agent-update-manager.ts` does those
 * and asks this file every question, so each rule is tested on its own.
 */
import { join } from 'node:path'
import type { AgentInstall, AgentUpdateId } from '../../shared/agent-updates'

/** The npm package each agent is published as, when Clave knows it. Used for
 *  the latest version of an install whose path does not name its package
 *  (Claude's native installer, a Homebrew cask). Antigravity is not on npm. */
export const KNOWN_PACKAGES: Partial<Record<AgentUpdateId, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex'
}

/** The package directory under a `node_modules/` segment: `@scope/name` or `name`. */
function packageAfterNodeModules(path: string, marker: string): string | null {
  const at = path.lastIndexOf(marker)
  if (at < 0) return null
  const rest = path.slice(at + marker.length).split('/')
  if (!rest[0]) return null
  if (rest[0].startsWith('@')) return rest[1] ? `${rest[0]}/${rest[1]}` : null
  return rest[0]
}

/**
 * Classifies an install from the binary's real path (symlinks followed). The
 * order matters: an app bundle wins over everything (the app updates what it
 * ships). A package is the one the person installed globally, the first
 * directory under the global `node_modules/` — except pnpm's, whose global
 * links resolve into its content store (`.pnpm/<pkg>@<v>/node_modules/<pkg>`),
 * where the package is the one after the last `node_modules/`.
 */
export function classifyInstall(realPath: string, id: AgentUpdateId): AgentInstall {
  const p = realPath.replace(/\\/g, '/')

  const app = /\/([^/]+\.app)\/Contents\//.exec(p)
  if (app) return { kind: 'app', app: app[1] }

  if (id === 'claude' && p.includes('/.local/share/claude/versions/')) {
    return { kind: 'claude-native' }
  }

  const cask = /\/Caskroom\/([^/]+)\//.exec(p)
  if (cask) return { kind: 'homebrew', name: cask[1], cask: true }
  const formula = /\/Cellar\/([^/]+)\//.exec(p)
  if (formula) return { kind: 'homebrew', name: formula[1], cask: false }

  if (p.includes('/.bun/install/global/node_modules/')) {
    const pkg = packageAfterNodeModules(p, '/.bun/install/global/node_modules/')
    if (pkg) return { kind: 'package', manager: 'bun', pkg }
  }
  if (/\/pnpm\/global\/[^/]+\/(?:\.pnpm\/[^/]+\/)?node_modules\//.test(p)) {
    const pkg = packageAfterNodeModules(p, '/node_modules/')
    if (pkg) return { kind: 'package', manager: 'pnpm', pkg }
  }
  if (p.includes('/yarn/global/node_modules/')) {
    const pkg = packageAfterNodeModules(p, '/yarn/global/node_modules/')
    if (pkg) return { kind: 'package', manager: 'yarn', pkg }
  }
  const npm = /^(.*)\/lib\/node_modules\//.exec(p)
  if (npm) {
    const pkg = packageAfterNodeModules(p, '/lib/node_modules/')
    if (pkg) return { kind: 'package', manager: 'npm', pkg, prefix: npm[1] }
  }
  return { kind: 'unknown' }
}

/** Where the install came from, as the settings row says it. */
export function describeInstall(install: AgentInstall): string {
  switch (install.kind) {
    case 'claude-native':
      return "Claude's installer"
    case 'homebrew':
      return install.cask ? `Homebrew cask ${install.name}` : `Homebrew formula ${install.name}`
    case 'package':
      return `${install.manager} global ${install.pkg}`
    case 'app':
      return `Bundled with ${install.app}`
    case 'unknown':
      return 'Installed outside a known installer'
  }
}

/** Whether Clave may upgrade this install at all. */
export function canUpgrade(install: AgentInstall): boolean {
  return install.kind !== 'app' && install.kind !== 'unknown'
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/** The first semantic version in a `--version` answer (`codex-cli 0.159.0`,
 *  `2.1.285 (Claude Code)`), or null. */
export function parseVersion(output: string): string | null {
  const match = VERSION_RE.exec(output)
  return match ? match[0] : null
}

/**
 * Semver order, enough for release versions: major.minor.patch numerically,
 * and a pre-release below its release. Returns <0, 0 or >0. An unparsable
 * side compares as equal, so a strange string never claims an update.
 */
export function compareVersions(a: string, b: string): number {
  const x = VERSION_RE.exec(a)
  const y = VERSION_RE.exec(b)
  if (!x || !y) return 0
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return d
  }
  if (x[4] && !y[4]) return -1
  if (!x[4] && y[4]) return 1
  if (x[4] && y[4]) return x[4] < y[4] ? -1 : x[4] > y[4] ? 1 : 0
  return 0
}

export function isNewer(latest: string | null, current: string | null): boolean {
  return !!latest && !!current && compareVersions(latest, current) > 0
}

/**
 * The npm package and dist-tag whose version is "latest" for this install.
 * Claude's installer follows the channel the person picked in Claude's own
 * settings (`autoUpdatesChannel`: `latest` by default, or `stable`), so
 * offering `latest` to a `stable` install would announce an update its own
 * installer refuses. Null when no registry speaks for the install.
 */
export function releaseSource(
  id: AgentUpdateId,
  install: AgentInstall,
  claudeChannel: string | null
): { pkg: string; tag: string } | null {
  if (install.kind === 'package') return { pkg: install.pkg, tag: 'latest' }
  const known = KNOWN_PACKAGES[id]
  if (!known) return null
  if (install.kind === 'claude-native') {
    return { pkg: known, tag: claudeChannel === 'stable' ? 'stable' : 'latest' }
  }
  if (install.kind === 'homebrew') return { pkg: known, tag: 'latest' }
  return null
}

export interface UpgradeCommand {
  /** A bare name resolved on the login PATH, or an absolute path. */
  file: string
  args: string[]
}

/**
 * The command that upgrades an install, as argv — never a shell string, so
 * nothing in a path or a package name is ever parsed by a shell. `bin` is the
 * agent's own binary on the PATH (Claude's installer upgrades itself). An npm
 * global is upgraded by the npm of ITS prefix when one sits there, so a CLI
 * installed under one Node version is not reinstalled under another.
 */
export function upgradeCommand(
  install: AgentInstall,
  bin: string,
  exists: (file: string) => boolean
): UpgradeCommand | null {
  switch (install.kind) {
    case 'claude-native':
      return { file: bin, args: ['update'] }
    case 'homebrew':
      return {
        file: 'brew',
        args: install.cask ? ['upgrade', '--cask', install.name] : ['upgrade', install.name]
      }
    case 'package':
      return packageCommand(install, exists)
    default:
      return null
  }
}

function packageCommand(
  install: Extract<AgentInstall, { kind: 'package' }>,
  exists: (file: string) => boolean
): UpgradeCommand {
  const spec = `${install.pkg}@latest`
  switch (install.manager) {
    case 'npm': {
      const own = install.prefix ? join(install.prefix, 'bin', 'npm') : null
      return { file: own && exists(own) ? own : 'npm', args: ['install', '-g', spec] }
    }
    case 'pnpm':
      return { file: 'pnpm', args: ['add', '-g', spec] }
    case 'bun':
      return { file: 'bun', args: ['add', '-g', spec] }
    case 'yarn':
      return { file: 'yarn', args: ['global', 'add', spec] }
  }
}
