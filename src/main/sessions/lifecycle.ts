/**
 * Starting and stopping a session, for whoever asks: the window over IPC
 * (`ipc-handlers/pty-handlers.ts`) and the server over its session host
 * (`sessions/host.ts`) call the same two functions, so a start is one piece
 * of wiring whatever transport brought it. Lifted out of the PTY handlers for
 * PRDCT-3239; the PTY backend itself is untouched.
 *
 * Nothing here imports Electron (PRDCT-3293): the window is a KEY, and what
 * still reaches a window (the binding, the workspace it shows, the per-window
 * sends, the flush a stop owes) goes through the session windows port
 * (`windows.ts`), which the shell implements over its registry and the
 * standalone server over a map.
 */
import { ptyManager, type PtySpawnOptions } from '../pty-manager'
import { workspaceManager } from '../workspace-manager'
import * as titleGenerator from '../title-generator'
import { clearState as clearAgentState } from '../agent-state-manager'
import { sessionWindows } from './windows'

export type SessionInfoResult = {
  id: string
  cwd: string
  folderName: string
  alive: boolean
  claudeSessionId: string | null
  piSessionId: string | null
  launchProfileId?: string
  model?: string
  piProvider?: string
  piThinking?: PtySpawnOptions['piThinking']
}

/** The tmux switch lives in the app's own preferences file
 *  (`clave-preferences.json`, read by the .clave handlers, which import
 *  Electron): the shell installs the reader at boot; a host with none
 *  (the standalone server) runs tmux, the default. */
let tmuxPreference: () => unknown = () => undefined
export function setTmuxPreferenceReader(reader: (() => unknown) | null): void {
  tmuxPreference = reader ?? (() => undefined)
}

/** What each terminal's reader typed since the last Enter, to see a `/clear`. */
const inputBuffers = new Map<string, string>()

/** Watch a terminal's input for `/clear`: the title generator then expects
 *  the transcript to rotate. */
export function trackInput(id: string, data: string): void {
  let buf = inputBuffers.get(id) ?? ''
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      if (/^\/clear\s*$/.test(buf.trim())) titleGenerator.notifyClear(id)
      buf = ''
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1)
    } else if (ch === '\x03' || ch === '\x15') {
      // Ctrl+C or Ctrl+U clears the line.
      buf = ''
    } else if (ch >= ' ') {
      buf += ch
    }
  }
  inputBuffers.set(id, buf)
}

/** The spawn, for the window that asked (by its key; null for a windowless
 *  caller): the session, its listeners and its window binding. `pty:spawn`,
 *  `pty:restart` and the server's `StartSession` share it, so a restart on
 *  another account (ADR 0002) is the same spawn with the account changed,
 *  never a second copy of this wiring. */
export async function spawnSession(
  windowKey: string | null,
  cwd: string,
  options?: PtySpawnOptions
): Promise<SessionInfoResult> {
  const windows = sessionWindows()
  // tmux mode is a global app setting, ON by default. Honour it unless a
  // caller overrides per-spawn or the user explicitly turned it off. (When
  // tmux isn't installed the spawn transparently falls back to a plain shell.)
  const tmuxMode = options?.tmuxMode ?? tmuxPreference() !== false
  // Central workspace stamp: every spawn defaults to the workspace of the
  // WINDOW that asked (the registry's truth, never the state file — another
  // window may have switched or written last). Explicit values win (pin
  // launches into a hidden workspace, MCP caller inheritance, adoption); the
  // persisted last-active workspace survives only for a windowless caller.
  const workspaceId =
    options?.workspaceId ??
    (windowKey ? windows.workspaceOf(windowKey) : null) ??
    workspaceManager.getLastActiveWorkspaceId() ??
    undefined
  // The asking window is the session's HOME: its persisted key goes on the
  // record, so the next boot brings the tab back in that window (an
  // adoption or a move re-stamps through this same path).
  const session = await ptyManager.spawn(cwd, {
    ...options,
    tmuxMode,
    workspaceId,
    windowKey: windowKey ?? undefined
  })
  // The sender hosts the session from now on: its renderer holds the xterm
  // and receives pty:data. Adoption and re-homing rebind through this same
  // path (the adopting window is the sender).
  if (windowKey) windows.bind(session.id, windowKey)
  const isClaudeMode =
    options?.claudeMode !== false &&
    !options?.antigravityMode &&
    !options?.codexMode &&
    !options?.piMode &&
    !options?.claudeAgentsMode
  const isResumed = !!options?.resumeSessionId

  // A fresh Claude session is named by its first message, by the agent it
  // runs: its resolved profile, on its account.
  if (isClaudeMode && !isResumed && session.claudeSessionId) {
    titleGenerator.scheduleTitleGeneration(
      session.id,
      session.cwd,
      session.claudeSessionId,
      windowKey,
      {
        workspaceId,
        launchProfileId: session.launchProfileId,
        claudeProfileId: options?.claudeProfileId,
        configDir: options?.configDir
      }
    )
  }

  // Attach listeners now so the channels are ready before the renderer
  // triggers the actual pty.spawn() via pty:start (or first pty:resize).
  ptyManager.attachListeners(
    session.id,
    (data) => windows.send(windowKey, `pty:data:${session.id}`, data),
    (exitCode) => {
      titleGenerator.cleanup(session.id)
      inputBuffers.delete(session.id)
      clearAgentState(session.id)
      windows.unbind(session.id)
      windows.send(windowKey, `pty:exit:${session.id}`, exitCode)
    }
  )

  if (session.claudeSessionId) {
    console.log(
      `[claude-session] PTY ${session.id} → claude session ${session.claudeSessionId}${options?.resumeSessionId ? ' (resumed)' : ' (new)'}`
    )
  }

  return {
    id: session.id,
    cwd: session.cwd,
    folderName: session.folderName,
    alive: session.alive,
    claudeSessionId: session.claudeSessionId ?? null,
    piSessionId: session.piSessionId ?? null,
    launchProfileId: session.launchProfileId,
    model: session.model,
    piProvider: session.piProvider,
    piThinking: session.piThinking
  }
}

/** A terminal's size from its pane: the first call starts the process at
 *  that size (the backend defers the spawn until then), a later one resizes
 *  it. Nothing happens for a session that is not a terminal. */
export function resizeSession(id: string, cols: number, rows: number): void {
  ptyManager.resize(id, cols, rows)
}

/** Terminal bytes from the pane: watched for a `/clear`, journaled in test
 *  mode, written to the process. Nothing happens for a session that is not a
 *  terminal. */
export function writeTerminal(id: string, text: string): void {
  trackInput(id, text)
  ptyManager.write(id, text)
}

/** Stop a session: what its window owes first (a linked document flushed),
 *  then the process is killed and the window binding released. A session
 *  that never started has no exit event to unbind it, so the unbind is here
 *  too. */
export async function stopSession(id: string): Promise<void> {
  const windows = sessionWindows()
  // What the window owes goes through the server (wave 3): an app that runs
  // without a server, or a window that does not answer, must not hold the
  // close. The document keeps its last flushed revision and the tab goes.
  await windows
    .beforeStop(id)
    .catch((error) =>
      console.error('[sessions] linked document not flushed before the stop', error)
    )
  await ptyManager.kill(id)
  windows.unbind(id)
}
