import { useCallback, useState } from 'react'
import { useSessionStore } from '../../store/session-store'
import { getActiveWorkspaceId, workspaceServer } from '../../store/workspace-store'
import { getLastAgentSetup } from '../../store/launch-prefs'
import { launchSession } from '../../lib/launch-session'

export function NewSessionButton(): React.JSX.Element {
  const addSession = useSessionStore((s) => s.addSession)
  const [loading, setLoading] = useState(false)

  const handleNewSession = useCallback(async () => {
    setLoading(true)
    try {
      // In a server workspace the empty state starts where the workspace
      // lives: on its server, at its root, through the normal launch (#241).
      const workspaceId = getActiveWorkspaceId()
      if (workspaceServer(workspaceId)) {
        await launchSession({
          setup: getLastAgentSetup(workspaceId),
          cwd: { kind: 'workspace-root' }
        })
        return
      }
      const folderPath = await window.electronAPI.openFolderDialog()
      if (!folderPath) return

      const state = useSessionStore.getState()
      const otherProvider =
        state.antigravityMode || state.codexMode || state.piMode || state.claudeAgentsMode
      const sessionInfo = await window.electronAPI.spawnSession(folderPath, {
        claudeMode: otherProvider ? false : state.claudeMode,
        antigravityMode: state.antigravityMode,
        codexMode: state.codexMode,
        piMode: state.piMode,
        claudeAgentsMode: state.claudeAgentsMode,
        dangerousMode: state.dangerousMode
      })
      addSession({
        id: sessionInfo.id,
        cwd: sessionInfo.cwd,
        folderName: sessionInfo.folderName,
        name: sessionInfo.folderName,
        alive: sessionInfo.alive,
        activityStatus: 'idle',
        promptWaiting: null,
        claudeMode: otherProvider ? false : state.claudeMode,
        antigravityMode: state.antigravityMode,
        codexMode: state.codexMode,
        piMode: state.piMode,
        claudeAgentsMode: state.claudeAgentsMode,
        dangerousMode: state.dangerousMode,
        model: sessionInfo.model,
        claudeSessionId: sessionInfo.claudeSessionId,
        piSessionId: sessionInfo.piSessionId,
        launchProfileId: sessionInfo.launchProfileId,
        piProvider: sessionInfo.piProvider,
        piThinking: sessionInfo.piThinking,
        sessionType: 'local'
      })
    } catch (err) {
      console.error('Failed to create session:', err)
    } finally {
      setLoading(false)
    }
  }, [addSession])

  return (
    <button
      onClick={handleNewSession}
      disabled={loading}
      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-surface-200 hover:bg-surface-300 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium disabled:opacity-50"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {loading ? 'Starting...' : 'New Session'}
    </button>
  )
}
