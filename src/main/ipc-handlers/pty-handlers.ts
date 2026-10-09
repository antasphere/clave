import { ipcMain, BrowserWindow } from 'electron'
import {
  ptyManager,
  isTmuxAvailable,
  scrollTmuxSessionToText,
  type PtySpawnOptions
} from '../pty-manager'
import { installTerminalPorts } from '../ports/terminals'
import { getMcpRuntime, writeSessionMcpConfig, deleteSessionMcpConfig } from '../mcp/mcp-runtime'
import { registerSessionIpc } from '../sessions/ipc'
import { windowRegistry } from '../window-registry'
import { windowState } from '../window-state'
import { startWatching as startAgentStateWatching } from '../agent-state-manager'
import { hasServerEventPublisher } from '../server/session-events'
import {
  type SessionInfoResult,
  setTmuxPreferenceReader,
  spawnSession,
  stopSession,
  trackInput
} from '../sessions/lifecycle'
import { getPreference } from './clave-file-handlers'
import { installSessionWindows } from '../sessions/windows'
import { electronSessionWindows } from '../sessions/electron-windows'
import { recordsForIds } from '../sessions/records-by-id'

export function registerPtyHandlers(): void {
  // The shell wires the terminal layer's MCP config port to its own MCP
  // server: a Claude session's `--mcp-config` file is the MCP runtime's
  // (`mcp-runtime.ts`), written when the server is up and omitted before.
  // The storage and the terminal process keep the layer's defaults here (the
  // app's data folder, node-pty in this process).
  installTerminalPorts({
    mcpConfig: {
      write: (sessionId) => (getMcpRuntime() ? writeSessionMcpConfig(sessionId) : null),
      remove: deleteSessionMcpConfig
    }
  })
  // What the session host still needs from the windows, by key: the shell's
  // registry and IPC sends (sessions/windows.ts, PRDCT-3293).
  installSessionWindows(electronSessionWindows)
  // The tmux switch comes from the app's own preferences file.
  setTmuxPreferenceReader(() => getPreference('tmuxMode'))
  // The session stream's IPC, registered once with the terminal handlers (the
  // agent state manager used to do it from the watch below and owns no IPC).
  registerSessionIpc()
  // Deterministic Claude session state (from CC lifecycle hooks) → renderer.
  // With the server running the same state travels as `session.state_changed`
  // on the push channel (the manager publishes it, server/clave-server.ts):
  // the per-window send is for an app without one, never beside it (the
  // verifier's round 1 saw a terminal's state arrive twice).
  startAgentStateWatching((claveSessionId, state) => {
    if (hasServerEventPublisher()) return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(`agent:state:${claveSessionId}`, state)
    }
  })

  /** Starting a session is `sessions/lifecycle.ts`'s: the server's
   *  `StartSession` and these handlers share one wiring, and the window is
   *  its key. */
  const spawnForWindow = (
    win: BrowserWindow | null,
    cwd: string,
    options?: PtySpawnOptions
  ): Promise<SessionInfoResult> =>
    spawnSession(win ? windowRegistry.getKeyForWindow(win.id) : null, cwd, options)

  // The CLI's own word on its account's limit reaches the window holding the
  // tab (ADR 0002): the policy there proposes or makes the move.
  ptyManager.onLimitReported((sessionId) => {
    const win = windowRegistry.getWindowForSession(sessionId)
    if (win && !win.isDestroyed()) win.webContents.send('session:limit-reported', sessionId)
  })

  // `initialInput` is main's own (a restart's resend, pty-manager.ts): a
  // renderer's spawn never carries one.
  ipcMain.handle('pty:spawn', (_event, cwd: string, options?: PtySpawnOptions) =>
    spawnForWindow(
      BrowserWindow.fromWebContents(_event.sender),
      cwd,
      options && { ...options, initialInput: undefined }
    )
  )

  // A session moved to another account (ADR 0002): the process is stopped,
  // its record's name and view read first, and the same spawn made again
  // under the same id with the conversation resumed. The renderer remounts
  // the tab on the answer. `resumed` false means nothing was found to
  // resume — a Codex terminal whose thread is not in the store yet — and
  // the tab starts a fresh conversation on the new account.
  ipcMain.handle(
    'pty:restart',
    async (
      _event,
      id: string,
      overrides: {
        claudeProfileId?: unknown
        claudeProfileLabel?: unknown
        codexAccountId?: unknown
        codexAccountLabel?: unknown
        resendRejected?: unknown
      }
    ): Promise<(SessionInfoResult & { resumed: boolean }) | { error: string }> => {
      if (typeof id !== 'string') return { error: 'No session' }
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
      const plan = ptyManager.restartSpawn(id, {
        claudeProfileId: str(overrides?.claudeProfileId),
        claudeProfileLabel: str(overrides?.claudeProfileLabel),
        codexAccountId: str(overrides?.codexAccountId),
        codexAccountLabel: str(overrides?.codexAccountLabel),
        resendRejected: overrides?.resendRejected === true
      })
      if (!plan) return { error: 'This session cannot be restarted from here.' }
      const record = ptyManager.getSessionRecord(id)
      const win = BrowserWindow.fromWebContents(_event.sender)
      await ptyManager.killAndWait(id)
      windowRegistry.unbindSession(id)
      const info = await spawnForWindow(win, plan.cwd, plan.options)
      // The kill took the record's name and view with it; put them back.
      if (record?.displayName) {
        ptyManager.setSessionDisplayName(id, record.displayName, record.userRenamed === true)
      }
      if (record?.view) ptyManager.setSessionViewRecord(id, record.view)
      return { ...info, resumed: plan.resumed }
    }
  )

  // Renderer calls this once xterm has been fit, so claude/agy are spawned
  // at the real cols/rows instead of the default 80×24.
  ipcMain.on('pty:start', (_event, id: string, cols: number, rows: number) => {
    ptyManager.start(id, cols, rows)
  })

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    trackInput(id, data)
    ptyManager.write(id, data)
  })

  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows)
  })

  ipcMain.handle('pty:kill', (_event, id: string) => stopSession(id))

  ipcMain.handle('pty:list', () => {
    return ptyManager.getAllSessions()
  })

  // A rename only lives in the renderer store, which dies with the window.
  // Mirror it into the tmux sidecar so the tab keeps its name across a
  // restart, a crash, or a reboot instead of reverting to the folder name.
  ipcMain.handle(
    'session:set-display-name',
    (_event, id: string, displayName: string | null, userRenamed: boolean) => {
      ptyManager.setSessionDisplayName(id, displayName, userRenamed === true)
    }
  )

  // A `/clear` rotated the transcript: the record follows the new id (see
  // PtyManager.setSessionClaudeSessionId).
  ipcMain.handle('session:set-claude-session-id', (_event, id: string, claudeSessionId: string) => {
    if (typeof id !== 'string' || typeof claudeSessionId !== 'string') return
    ptyManager.setSessionClaudeSessionId(id, claudeSessionId)
  })

  // The message trail's click-to-scroll. Who owns the tab's scrollback decides
  // the path: a tmux-backed session is driven here (copy-mode + text search);
  // a plain one answers `tmux: false` and the renderer scans xterm's buffer.
  ipcMain.handle(
    'session:scroll-to-text',
    (_event, id: string, needle: string, fromBottom: number): { tmux: boolean } => {
      if (typeof id !== 'string' || typeof needle !== 'string') return { tmux: false }
      const tmuxName = ptyManager.tmuxNameOf(id)
      if (!tmuxName) return { tmux: false }
      const issued = scrollTmuxSessionToText(
        tmuxName,
        needle,
        typeof fromBottom === 'number' ? fromBottom : 1
      )
      return { tmux: issued }
    }
  )

  // A session's attached web view, persisted like its display name. The shape
  // is re-picked field by field: the renderer object crosses the IPC boundary
  // and must not smuggle extra keys into the record file.
  ipcMain.handle(
    'session:set-view',
    (
      _event,
      id: string,
      view: { url?: unknown; title?: unknown; command?: unknown; cwd?: unknown } | null
    ) => {
      const clean =
        view && typeof view.url === 'string' && view.url.length > 0
          ? {
              url: view.url,
              ...(typeof view.title === 'string' ? { title: view.title } : {}),
              ...(typeof view.command === 'string' ? { command: view.command } : {}),
              ...(typeof view.cwd === 'string' ? { cwd: view.cwd } : {})
            }
          : null
      ptyManager.setSessionViewRecord(id, clean)
    }
  )

  // Workspace reassignment (workspace removal, future "move to workspace") —
  // mirrored into the session record so the stamp survives restarts.
  ipcMain.handle('session:set-workspace', (_event, id: string, workspaceId: string | null) => {
    ptyManager.setSessionWorkspace(id, workspaceId)
  })

  // Lets the settings UI enable/disable the "persistent sessions" toggle.
  ipcMain.handle('tmux:available', () => {
    return isTmuxAvailable()
  })

  // On launch the renderer asks which sessions survived a previous run — live
  // tmux survivors to reattach silently, dead records (plain or post-reboot
  // tmux) to offer behind the restore prompt. Also prunes stale records.
  // With a workspaceId only that workspace's records come back: a secondary
  // window adopts and prompts for its own workspace, never for everyone's.
  // Unfiltered (the primary at boot) is today's behavior.
  // The records a window may bring back: its OWN (stamped with its key) —
  // plus, for the primary, the orphans (no stamp, or a window that no longer
  // exists). `ids` overrides the filter: the re-home path hands a window the
  // ids of sessions another window just released, whatever their stamp.
  ipcMain.handle('records:list-adoptable', (event, filter?: { ids?: unknown }) => {
    const all = ptyManager.listAdoptableSessions()
    if (filter && Array.isArray(filter.ids)) {
      // By id, the records of sessions this process already runs come back
      // too, marked `running` (sessions/records-by-id.ts, the rule's own test).
      return recordsForIds(all, filter.ids, {
        recordOf: (id) => ptyManager.getSessionRecord(id) ?? undefined,
        isAlive: (id) => ptyManager.getSession(id)?.alive === true
      })
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const key = win ? windowRegistry.getKeyForWindow(win.id) : null
    if (!win || !key) return []
    if (!windowRegistry.isPrimary(win.id)) return all.filter((r) => r.windowKey === key)
    const known = new Set([...windowState.keys(), ...windowRegistry.liveKeys()])
    return all.filter((r) => r.windowKey === key || !r.windowKey || !known.has(r.windowKey))
  })

  // User declined to bring a survivor back → destroy it (record + tmux session).
  ipcMain.handle('records:discard', (_event, key: string) => {
    ptyManager.discardSessionRecord(key)
  })
}
