import { useSessionStore } from '../store/session-store'

const RESTART_SIGINT_DELAY_MS = 150

/**
 * Make a session view's serving command run: restart in place when the hidden
 * serving session is alive (^C clears a wedged foreground, scrollback
 * survives), otherwise spawn a fresh hidden session and link it. The mirror of
 * ensureGroupTerminalRunning for session views — the serving session belongs
 * to the owning session, lives outside every group and outside displayOrder,
 * and dies with its owner (removeSession cascades the kill).
 */
export async function ensureSessionViewServer(ownerId: string): Promise<void> {
  const state = useSessionStore.getState()
  const owner = state.sessions.find((s) => s.id === ownerId)
  if (!owner) throw new Error('Session is gone')
  const view = owner.view
  if (!view?.command) throw new Error('The view has no serving command')

  const live = view.serverSessionId
    ? state.sessions.find((s) => s.id === view.serverSessionId && s.alive)
    : undefined
  if (live) {
    window.electronAPI.writeSession(live.id, '\x03')
    setTimeout(() => {
      window.electronAPI.writeSession(live.id, view.command + '\r')
    }, RESTART_SIGINT_DELAY_MS)
    return
  }

  const info = await window.electronAPI.spawnSession(view.cwd ?? owner.cwd, {
    claudeMode: false,
    initialCommand: view.command,
    autoExecute: true,
    // The serving session lives in its owner's workspace, not the active one.
    workspaceId: owner.workspaceId ?? undefined,
    // `serverSessionId` is renderer-only by design; the record's link is what
    // survives the quit, and without it this process came back as a tab.
    link: { kind: 'session-view', ownerId }
  })
  // The PTY only actually spawns when something calls start() with a size —
  // normally the terminal pane on first measure. This session is never
  // selected (hidden pane, zero size), so kick it explicitly or the command
  // would never run.
  window.electronAPI.startSession(info.id, 120, 30)
  useSessionStore.setState((current) => ({
    sessions: [
      ...current.sessions,
      {
        id: info.id,
        cwd: info.cwd,
        folderName: info.folderName,
        name: info.folderName,
        alive: info.alive,
        activityStatus: 'idle' as const,
        promptWaiting: null,
        claudeMode: false,
        antigravityMode: false,
        codexMode: false,
        dangerousMode: false,
        claudeSessionId: info.claudeSessionId ?? null,
        sessionType: 'local' as const,
        detectedUrl: null,
        serverStatus: null,
        serverCommand: null,
        hasUnseenActivity: false,
        userRenamed: false,
        planFilePath: null,
        workspaceId: owner.workspaceId
      }
    ]
  }))
  // Relink through the store action so the view object updates in place. The
  // record write repeats (serverSessionId is never persisted on the OWNER's
  // record — the serving session's own record carries the link instead, which
  // is what brings it back attached rather than as a tab).
  useSessionStore.getState().setSessionView(ownerId, { ...view, serverSessionId: info.id })
}
