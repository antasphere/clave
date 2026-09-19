import { registerSessionIpc } from './sessions/ipc'
import { sessionManager } from './sessions/session-manager'
import { app } from 'electron'
import { mkdirSync, readFileSync, existsSync, rmSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'

/**
 * Deterministic Claude Code session state, sourced from CC lifecycle hooks.
 *
 * Each Clave-spawned `claude` session is launched with `--settings` injecting a
 * tiny hook config (see pty-manager.ts) whose commands write a single state word
 * to `<userData>/agent-state/<claveSessionId>.state`. This manager owns that
 * directory and watches it, forwarding transitions to the renderer.
 *
 * Pi's bundled extension writes the same state words. Codex uses its TUI's OSC
 * runtime titles instead, consumed by use-terminal.ts. Antigravity stays neutral.
 */
import type { AgentState } from '../shared/session-model'
export type { AgentState } from '../shared/session-model'

const VALID: ReadonlySet<string> = new Set<AgentState>([
  'idle',
  'working',
  'blocked',
  'done',
  'ended'
])
const SUFFIX = '.state'

let stateDir: string | null = null
let watcher: FSWatcher | null = null

export function getStateDir(): string {
  if (!stateDir) {
    stateDir = join(app.getPath('userData'), 'agent-state')
    try {
      mkdirSync(stateDir, { recursive: true })
    } catch {
      // best-effort; reads/writes will simply no-op if this fails
    }
  }
  return stateDir
}

/** Absolute path of the state file a session's hooks write to. */
export function stateFilePath(claveSessionId: string): string {
  return join(getStateDir(), `${claveSessionId}${SUFFIX}`)
}

/**
 * Start watching the state directory. The callback fires on every valid
 * transition with the Clave session id (derived from the filename) and the new
 * state. Safe to call multiple times — only the first call installs the watcher.
 */
export function startWatching(onState: (claveSessionId: string, state: AgentState) => void): void {
  registerSessionIpc()
  if (watcher) return
  const dir = getStateDir()
  try {
    watcher = watch(dir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (!name.endsWith(SUFFIX)) return
      const claveSessionId = name.slice(0, -SUFFIX.length)
      const fp = join(dir, name)
      try {
        if (!existsSync(fp)) return
        const raw = readFileSync(fp, 'utf-8').trim()
        // A truncate-then-write can momentarily yield an empty/partial read;
        // we simply ignore anything that isn't a known state word and wait for
        // the follow-up change event carrying the full word.
        // Events adapters own state; retain hook files without racing the stream.
        if (sessionManager.get(claveSessionId)?.transport === 'events') return
        if (VALID.has(raw)) {
          sessionManager.setState(claveSessionId, raw as AgentState)
          onState(claveSessionId, raw as AgentState)
        }
      } catch {
        // transient read error — ignore
      }
    })
  } catch {
    // watching unavailable — feature degrades to no status updates
  }
}

/** Remove a session's state file (call on session exit/kill to avoid stale files). */
export function clearState(claveSessionId: string): void {
  try {
    rmSync(stateFilePath(claveSessionId), { force: true })
  } catch {
    // ignore
  }
}
