import { linkedDocuments } from '../linked-documents/runtime'
import { callRenderer } from '../mcp/mcp-bridge'
import { ipcMain, BrowserWindow } from 'electron'
import {
  ptyManager,
  isTmuxAvailable,
  scrollTmuxSessionToText,
  type PtySpawnOptions
} from '../pty-manager'
import { getPreference } from './clave-file-handlers'
import { workspaceManager } from '../workspace-manager'
import { windowRegistry } from '../window-registry'
import { windowState } from '../window-state'
import * as titleGenerator from '../title-generator'
import {
  startWatching as startAgentStateWatching,
  clearState as clearAgentState
} from '../agent-state-manager'

export function registerPtyHandlers(): void {
  // Buffer PTY input per session to detect /clear command
  const inputBuffers = new Map<string, string>()

  // Deterministic Claude session state (from CC lifecycle hooks) → renderer.
  startAgentStateWatching((claveSessionId, state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(`agent:state:${claveSessionId}`, state)
    }
  })

  ipcMain.handle('pty:spawn', async (_event, cwd: string, options?: PtySpawnOptions) => {
    const win = BrowserWindow.fromWebContents(_event.sender)
    // tmux mode is a global app setting, ON by default. Honour it unless a
    // caller overrides per-spawn or the user explicitly turned it off. (When
    // tmux isn't installed the spawn transparently falls back to a plain shell.)
    const tmuxMode = options?.tmuxMode ?? getPreference('tmuxMode') !== false
    // Central workspace stamp: every spawn defaults to the workspace of the
    // WINDOW that asked (the registry's truth, never the state file — another
    // window may have switched or written last). Explicit values win (pin
    // launches into a hidden workspace, MCP caller inheritance, adoption); the
    // persisted last-active workspace survives only for a windowless caller.
    const workspaceId =
      options?.workspaceId ??
      (win ? windowRegistry.getWorkspaceForWindow(win.id) : null) ??
      workspaceManager.getLastActiveWorkspaceId() ??
      undefined
    // The asking window is the session's HOME: its persisted key goes on the
    // record, so the next boot brings the tab back in that window (an
    // adoption or a move re-stamps through this same path).
    const windowKey = (win ? windowRegistry.getKeyForWindow(win.id) : null) ?? undefined
    const session = await ptyManager.spawn(cwd, { ...options, tmuxMode, workspaceId, windowKey })
    // The sender hosts the session from now on: its renderer holds the xterm
    // and receives pty:data. Adoption and re-homing rebind through this same
    // path (the adopting window is the sender).
    if (win) windowRegistry.bindSession(session.id, win.id)
    const isClaudeMode =
      options?.claudeMode !== false &&
      !options?.antigravityMode &&
      !options?.codexMode &&
      !options?.piMode &&
      !options?.claudeAgentsMode
    const isResumed = !!options?.resumeSessionId

    // Schedule title generation for new Claude-mode sessions
    if (isClaudeMode && !isResumed && session.claudeSessionId && win) {
      titleGenerator.scheduleTitleGeneration(session.id, session.cwd, session.claudeSessionId, win)
    }

    // Attach listeners now so the channels are ready before the renderer
    // triggers the actual pty.spawn() via pty:start (or first pty:resize).
    ptyManager.attachListeners(
      session.id,
      (data) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send(`pty:data:${session.id}`, data)
        }
      },
      (exitCode) => {
        titleGenerator.cleanup(session.id)
        inputBuffers.delete(session.id)
        clearAgentState(session.id)
        windowRegistry.unbindSession(session.id)
        if (win && !win.isDestroyed()) {
          win.webContents.send(`pty:exit:${session.id}`, exitCode)
        }
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
  })

  // Renderer calls this once xterm has been fit, so claude/agy are spawned
  // at the real cols/rows instead of the default 80×24.
  ipcMain.on('pty:start', (_event, id: string, cols: number, rows: number) => {
    ptyManager.start(id, cols, rows)
  })

  ipcMain.on('pty:write', (_event, id: string, data: string) => {
    // Track input to detect /clear command
    let buf = inputBuffers.get(id) ?? ''
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        // Enter pressed — check if the buffered line is /clear
        if (/^\/clear\s*$/.test(buf.trim())) {
          titleGenerator.notifyClear(id)
        }
        buf = ''
      } else if (ch === '\x7f' || ch === '\b') {
        buf = buf.slice(0, -1)
      } else if (ch === '\x03' || ch === '\x15') {
        // Ctrl+C or Ctrl+U — clear buffer
        buf = ''
      } else if (ch >= ' ') {
        buf += ch
      }
    }
    inputBuffers.set(id, buf)

    ptyManager.write(id, data)
  })

  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows)
  })

  ipcMain.handle('pty:kill', async (_event, id: string) => {
    const owner = windowRegistry.getWindowForSession(id)
    if (
      owner &&
      linkedDocuments()
        .list()
        .some((d) => d.sessionId === id)
    ) {
      await callRenderer('flushLinkedDocument', { sessionId: id, allowConflict: true }, owner)
    }
    await ptyManager.kill(id)
    // A session that never started has no exit event to unbind it.
    windowRegistry.unbindSession(id)
  })

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
      const wanted = new Set(filter.ids.filter((x): x is string => typeof x === 'string'))
      return all.filter((r) => wanted.has(r.id))
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
