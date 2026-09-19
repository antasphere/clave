import { emitTabClosed } from '../../lib/exchange-capture'
import { useCallback, useState, type ReactElement } from 'react'
import { ArrowTopRightOnSquareIcon, PlayIcon, ArrowDownTrayIcon, DocumentTextIcon, ChatBubbleBottomCenterTextIcon, StopIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import { useClaudeProfileStore } from '../../store/claude-profile-store'
import { cn } from '@clave/ui/components'
import { safePort } from '../../lib/utils'
import { ConfirmDialog } from '@clave/ui/components'
import { SessionCopyOffers } from './SessionCopyOffers'

interface TerminalHeaderProps {
  sessionId: string
}

export function TerminalHeader({ sessionId }: TerminalHeaderProps): ReactElement | null {
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const multiProfile = useClaudeProfileStore((s) => s.profiles.length > 1)
  const removeSession = useSessionStore((s) => s.removeSession)
  const setSessionServerStatus = useSessionStore((s) => s.setSessionServerStatus)
  const messageTrailEnabled = useSessionStore((s) => s.messageTrailEnabled)
  const setMessageTrailEnabled = useSessionStore((s) => s.setMessageTrailEnabled)
  const [showConfirm, setShowConfirm] = useState(false)

  const handleKill = useCallback(async () => {
    const current = useSessionStore.getState()
    const closing = current.sessions.find((s) => s.id === sessionId)
    if (closing) emitTabClosed(closing, current.groups, 'user', null)
    try {
      await window.electronAPI.killSession(sessionId)
    } catch {
      // session may already be dead
    }
    removeSession(sessionId)
    setShowConfirm(false)
  }, [sessionId, removeSession])

  const handleServerToggle = useCallback(() => {
    if (!session) return

    if (session.serverStatus === 'running' && session.detectedUrl) {
      // Running → open in browser
      window.electronAPI.openExternal(session.detectedUrl)
    } else if (session.serverStatus === 'stopped' && session.serverCommand) {
      // Stopped → restart by writing command to PTY
      setSessionServerStatus(sessionId, 'starting')
      window.electronAPI.writeSession(sessionId, session.serverCommand + '\r')
    }
  }, [session, sessionId, setSessionServerStatus])

  const handleServerStop = useCallback(() => {
    if (!session || session.serverStatus !== 'running') return
    // Send Ctrl+C to the terminal
    window.electronAPI.writeSession(sessionId, '\x03')
  }, [session, sessionId])

  if (!session) return null

  const serverStatus = session.serverStatus
  const hasServer = session.detectedUrl && serverStatus

  return (
    <>
      <div className="flex items-center justify-between pl-3 pr-0.5 py-0.5 bg-surface-0 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full flex-shrink-0',
              session.activityStatus === 'active' && 'bg-status-working',
              session.activityStatus === 'idle' && 'bg-status-ready',
              session.activityStatus === 'ended' && 'bg-status-inactive'
            )}
            style={session.activityStatus === 'active' ? { animation: 'pulse-dot 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite' } : undefined}
          />
          <span className="text-xs font-medium text-text-secondary truncate">{session.name}</span>
          {multiProfile && session.claudeProfileLabel && (session.claudeMode || session.claudeAgentsMode) && (
            <span
              className="badge flex-shrink-0"
              title={`Claude account: ${session.claudeProfileLabel}${session.claudeConfigDir ? ` (${session.claudeConfigDir})` : ''}`}
            >
              {session.claudeProfileLabel}
            </span>
          )}
          {hasServer && (
            <div className="flex items-center gap-0.5 flex-shrink-0">
              <button
                onClick={handleServerToggle}
                disabled={serverStatus === 'starting'}
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors flex-shrink-0',
                  serverStatus === 'running' && 'text-emerald-500 hover:bg-emerald-500/10',
                  serverStatus === 'stopped' && 'text-red-400 hover:bg-red-400/10',
                  serverStatus === 'starting' && 'text-amber-400 cursor-wait'
                )}
                title={
                  serverStatus === 'running' ? `Open ${session.detectedUrl}` :
                  serverStatus === 'stopped' ? `Restart server (${session.serverCommand})` :
                  'Starting server…'
                }
              >
                {/* Status dot */}
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full flex-shrink-0',
                    serverStatus === 'running' && 'bg-emerald-500',
                    serverStatus === 'stopped' && 'bg-red-400',
                    serverStatus === 'starting' && 'bg-amber-400'
                  )}
                  style={
                    serverStatus === 'running' || serverStatus === 'starting'
                      ? { animation: 'pulse-dot 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite' }
                      : undefined
                  }
                />
                {/* Port label */}
                <span>{`:${safePort(session.detectedUrl!) ?? '?'}`}</span>
                {/* Action icon */}
                {serverStatus === 'running' && <ArrowTopRightOnSquareIcon className="w-3 h-3" />}
                {serverStatus === 'stopped' && <PlayIcon className="w-3 h-3" />}
              </button>
              {/* Stop button — only when running */}
              {serverStatus === 'running' && (
                <button
                  onClick={handleServerStop}
                  className="panel-icon-btn hover:!text-red-400"
                  title="Stop server (Ctrl+C)"
                >
                  <StopIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          <SessionCopyOffers sessionId={sessionId} />
          {session.claudeSessionId && (
            <button
              onClick={() => setMessageTrailEnabled(!messageTrailEnabled)}
              className="panel-icon-btn"
              data-active={messageTrailEnabled ? 'true' : undefined}
              title={messageTrailEnabled ? 'Hide message trail' : 'Show message trail'}
            >
              <ChatBubbleBottomCenterTextIcon className="w-4 h-4" />
            </button>
          )}
          {session.claudeMode && session.claudeSessionId && (
            <>
              <button
                onClick={() =>
                  window.electronAPI.saveDiscussion(session.cwd, session.claudeSessionId!, session.name, {
                    sessionType: session.sessionType,
                    locationId: session.locationId ?? null
                  })
                }
                className="panel-icon-btn"
                title="Save discussion"
              >
                <ArrowDownTrayIcon className="w-4 h-4" />
              </button>
              {session.planFilePath && (
                <button
                  onClick={() =>
                    window.electronAPI.savePlan(session.cwd, session.claudeSessionId!, session.name, {
                      sessionType: session.sessionType,
                      locationId: session.locationId ?? null
                    })
                  }
                  className="panel-icon-btn"
                  title="Save plan"
                >
                  <DocumentTextIcon className="w-4 h-4" />
                </button>
              )}
            </>
          )}
          <button
            onClick={() => setShowConfirm(true)}
            className="panel-icon-btn"
            title="Kill session"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showConfirm}
        title="Delete session"
        message="Are you sure you want to delete this session? This will terminate the process."
        onConfirm={handleKill}
        onCancel={() => setShowConfirm(false)}
      />
    </>
  )
}
