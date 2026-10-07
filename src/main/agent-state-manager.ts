import { sessionManager } from './sessions/session-manager'
import { lazyTerminalPorts } from './ports/terminals'
import { mkdirSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'

/**
 * Deterministic Claude Code session state, sourced from CC lifecycle hooks.
 *
 * Each Clave-spawned `claude` session is launched with `--settings` injecting a
 * tiny hook config (see pty-backend.ts) whose commands write a single state word
 * to `<data>/agent-state/<claveSessionId>.state`. This manager owns that
 * folder, through the terminal layer's storage port, and watches it,
 * forwarding transitions to whoever started the watch (the shell fans them
 * out to its windows).
 *
 * Pi's bundled extension writes the same state words. Codex uses its TUI's OSC
 * runtime titles instead, consumed by use-terminal.ts. Antigravity stays neutral.
 *
 * Nothing here imports Electron: the folder comes from the storage port, so
 * the same file runs under the app and under a server of its own.
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
/** The folder, as the storage port names a document under it. */
const FOLDER = 'agent-state'

let watcher: FSWatcher | null = null
/** The last word forwarded per session. The kernel may deliver one write as
 *  two events and two writes as one; a hook writes `working` on every tool
 *  call. Forwarding a word only when it differs from the last one makes a
 *  transition one transition everywhere, and the renderer never sees the
 *  same state twice per hook. */
const lastForwarded = new Map<string, AgentState>()

/** The folder's absolute path, created on first ask: the hooks' `mkdir -p`
 *  recreates it after a deletion, but the watch below needs it first. */
export function getStateDir(): string {
  const dir = lazyTerminalPorts.storage.pathOf(FOLDER)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // best-effort; reads/writes will simply no-op if this fails
  }
  return dir
}

/** The document name of a session's state file, for the storage port. */
function stateDocument(claveSessionId: string): string {
  return `${FOLDER}/${claveSessionId}${SUFFIX}`
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
  if (watcher) return
  const dir = getStateDir()
  try {
    watcher = watch(dir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (!name.endsWith(SUFFIX)) return
      const claveSessionId = name.slice(0, -SUFFIX.length)
      try {
        // A truncate-then-write can momentarily yield an empty/partial read;
        // we simply ignore anything that isn't a known state word and wait for
        // the follow-up change event carrying the full word. A missing file
        // (a clearState) reads as null and is nothing either.
        const raw = lazyTerminalPorts.storage.read(stateDocument(claveSessionId))?.trim()
        if (!raw) return
        // Events adapters own state; retain hook files without racing the stream.
        if (sessionManager.get(claveSessionId)?.transport === 'events') return
        if (VALID.has(raw) && lastForwarded.get(claveSessionId) !== raw) {
          lastForwarded.set(claveSessionId, raw as AgentState)
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

/** Stop the watch (tests); the next `startWatching` installs a new one. */
export function stopWatching(): void {
  watcher?.close()
  watcher = null
  lastForwarded.clear()
}

/** Remove a session's state file (call on session exit/kill to avoid stale files). */
export function clearState(claveSessionId: string): void {
  lastForwarded.delete(claveSessionId)
  try {
    lazyTerminalPorts.storage.remove(stateDocument(claveSessionId))
  } catch {
    // ignore
  }
}
