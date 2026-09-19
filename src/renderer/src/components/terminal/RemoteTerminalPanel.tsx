import { useCallback, useEffect } from 'react'
import { useRemoteTerminal } from '../../hooks/use-remote-terminal'
import { useSessionStore } from '../../store/session-store'
import { useLocationStore } from '../../store/location-store'
import { TerminalHeader } from './TerminalHeader'
import { cn } from '@clave/ui/components'
import { GlobeAltIcon } from '@heroicons/react/24/outline'

interface RemoteTerminalPanelProps {
  sessionId: string
  shellId: string
  locationId: string
}

export function RemoteTerminalPanel({ sessionId, shellId, locationId }: RemoteTerminalPanelProps) {
  const { containerRef, focus } = useRemoteTerminal(shellId)
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const setFocusedSession = useSessionStore((s) => s.setFocusedSession)
  const location = useLocationStore((s) => s.locations.find((l) => l.id === locationId))
  const session = useSessionStore((s) => s.sessions.find((s) => s.id === sessionId))
  const isFocused = focusedSessionId === sessionId
  const isClaudeMode = session?.sessionType === 'remote-claude' || session?.claudeMode

  // Auto-focus xterm when this panel becomes the focused session (includes initial mount)
  useEffect(() => {
    if (isFocused) {
      const timer = setTimeout(() => focus(), 50)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isFocused, focus])

  // Auto-focus xterm when the window regains focus (Cmd+Tab, clicking from another app)
  useEffect(() => {
    const handleWindowFocus = () => {
      if (useSessionStore.getState().focusedSessionId === sessionId) {
        focus()
      }
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => window.removeEventListener('focus', handleWindowFocus)
  }, [sessionId, focus])

  const handleClick = useCallback(() => {
    if (focusedSessionId !== sessionId) {
      setFocusedSession(sessionId)
    }
    focus()
  }, [sessionId, focusedSessionId, setFocusedSession, focus])

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-surface-0 transition-shadow',
        ''
      )}
      onMouseDown={handleClick}
    >
      <TerminalHeader sessionId={sessionId} />
      {location && (
        <div className="flex items-center gap-2 px-3 py-1 bg-accent/5 border-b border-border-subtle text-xs text-text-tertiary">
          <GlobeAltIcon className="w-3.5 h-3.5" />
          <span>
            {isClaudeMode ? 'Claude Code on' : 'Connected to'} {location.name} &middot; {location.host} via SSH
          </span>
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}
