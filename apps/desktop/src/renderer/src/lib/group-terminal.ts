import { useSessionStore } from '../store/session-store'

const RESTART_SIGINT_DELAY_MS = 150

/**
 * Make a group terminal's command run: restart in place when its session is
 * alive (^C clears a wedged foreground or a half-typed prompt, scrollback
 * survives), otherwise spawn a fresh linked session. Never changes the user's
 * selection — callers decide what to look at (the group view panel keeps the
 * view up while the server boots).
 */
export async function ensureGroupTerminalRunning(
  groupId: string,
  terminalId: string
): Promise<void> {
  const state = useSessionStore.getState()
  const group = state.groups.find((g) => g.id === groupId)
  if (!group) throw new Error('Group is gone')
  const terminal = group.terminals.find((t) => t.id === terminalId)
  if (!terminal) throw new Error('Group terminal is gone')

  const live = terminal.sessionId
    ? state.sessions.find((s) => s.id === terminal.sessionId && s.alive)
    : undefined
  if (live) {
    window.electronAPI.writeSession(live.id, '\x03')
    setTimeout(() => {
      window.electronAPI.writeSession(live.id, (terminal.command || '') + '\r')
    }, RESTART_SIGINT_DELAY_MS)
    return
  }

  const cwd =
    terminal.cwd ?? group.cwd ?? state.sessions.find((s) => group.sessionIds.includes(s.id))?.cwd
  if (!cwd) throw new Error('Group has no working directory')

  const info = await window.electronAPI.spawnSession(cwd, {
    claudeMode: false,
    initialCommand: terminal.command || undefined,
    autoExecute: !!terminal.command && terminal.commandMode === 'auto',
    workspaceId: group.workspaceId ?? undefined,
    // Stamp the owner on the record: the sidebar layout's own link is dropped
    // with the group, and a session that comes back unlinked comes back as a
    // tab beside the group instead of inside it.
    link: { kind: 'group-terminal', groupId: group.id, terminalId }
  })
  // The PTY only actually spawns when something calls start() with a size —
  // normally the terminal pane on first measure. This session stays unselected
  // (display:none pane, zero size), so kick it explicitly or the command would
  // not run until the user looks at the terminal. A later attach just resizes.
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
        workspaceId: group.workspaceId
      }
    ]
  }))
  useSessionStore.getState().setGroupTerminalSessionId(group.id, terminalId, info.id)
}
