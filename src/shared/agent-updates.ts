/**
 * The agent-updates contract, shared by main, preload and renderer.
 *
 * Clave launches agent CLIs it does not ship: `claude`, `codex`, `agy`, `pi`,
 * each installed on the machine its own way. The main process keeps each one
 * on its latest release (`src/main/agent-updates/`); this is the state the
 * renderer pulls and is pushed, the same pull-and-push shape as the app's own
 * updater (`updater-types.ts`).
 */

export type AgentUpdateId = 'claude' | 'codex' | 'antigravity' | 'pi'

/**
 * How a CLI was installed, read off where its binary really lives. It decides
 * who upgrades it: always the installer that owns it, never a second copy
 * beside it (a second copy is the one the PATH does not reach).
 */
export type AgentInstall =
  /** Claude's own installer: versions under `~/.local/share/claude/versions/`. */
  | { kind: 'claude-native' }
  | { kind: 'homebrew'; name: string; cask: boolean }
  | { kind: 'package'; manager: 'npm' | 'pnpm' | 'bun' | 'yarn'; pkg: string; prefix?: string }
  /** Shipped inside a Mac app, which updates it itself. Never touched. */
  | { kind: 'app'; app: string }
  /** Found, but not in any shape Clave knows how to upgrade. Never touched. */
  | { kind: 'unknown' }

export type AgentUpdatePhase = 'idle' | 'checking' | 'updating'

export interface AgentUpdateStatus {
  id: AgentUpdateId
  /** Display name: Claude, Codex, Antigravity, Pi. */
  name: string
  /** The command Clave launches (`claude`, `codex`, `agy`, `pi`). */
  command: string
  /** False once a check found no binary on the login PATH. */
  installed: boolean
  /** The binary on the PATH, and the file it resolves to. */
  path: string | null
  realPath: string | null
  install: AgentInstall | null
  currentVersion: string | null
  /** The newest release the owning installer's channel offers, when known. */
  latestVersion: string | null
  /** True when `latestVersion` is newer than `currentVersion` and Clave can upgrade it. */
  updateAvailable: boolean
  phase: AgentUpdatePhase
  lastCheckedAt: number | null
  /** When Clave last moved this agent to a new version, in this app run. */
  lastUpdatedAt: number | null
  /** The version it moved from, for the "updated from" line. */
  updatedFrom: string | null
  /** A plain sentence the settings row shows under the version (never an error). */
  note: string | null
  /** The last check or upgrade that failed, verbatim enough to act on. */
  error: string | null
}

export interface AgentUpdatesState {
  /** Upgrade on its own (default) or only say an upgrade exists. */
  autoUpdate: boolean
  /** A check pass or an upgrade is running. */
  busy: boolean
  agents: AgentUpdateStatus[]
}

export const AGENT_UPDATE_TARGETS: readonly { id: AgentUpdateId; name: string; command: string }[] =
  [
    { id: 'claude', name: 'Claude', command: 'claude' },
    { id: 'codex', name: 'Codex', command: 'codex' },
    { id: 'antigravity', name: 'Antigravity', command: 'agy' },
    { id: 'pi', name: 'Pi', command: 'pi' }
  ]

/** The agent a session runs, from its mode flags; null for a plain terminal. */
export function agentUpdateIdOf(session: {
  claudeMode?: boolean
  codexMode?: boolean
  antigravityMode?: boolean
  piMode?: boolean
}): AgentUpdateId | null {
  if (session.claudeMode) return 'claude'
  if (session.codexMode) return 'codex'
  if (session.antigravityMode) return 'antigravity'
  if (session.piMode) return 'pi'
  return null
}
