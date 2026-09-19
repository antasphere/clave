import { useCallback, useEffect } from 'react'
import { useTerminal } from '../../hooks/use-terminal'
import { useSessionStore } from '../../store/session-store'
import { TerminalHeader } from './TerminalHeader'
import { MessageTrail } from './MessageTrail'
import { cn } from '@clave/ui/components'

interface TerminalPanelProps {
  sessionId: string
}

export function TerminalPanel({ sessionId }: TerminalPanelProps): React.JSX.Element {
  const { containerRef, focus } = useTerminal(sessionId)
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const setFocusedSession = useSessionStore((s) => s.setFocusedSession)
  const isFocused = focusedSessionId === sessionId

  // Auto-focus xterm when this panel becomes the focused session (includes initial mount)
  useEffect(() => {
    if (isFocused) {
      // Small delay lets xterm fully initialize on first mount
      const timer = setTimeout(() => {
        if (!document.activeElement?.closest('[data-testid="linked-document-panel"]')) focus()
      }, 50)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isFocused, focus])

  // Auto-focus xterm when the window regains focus (Cmd+Tab, clicking from another app)
  useEffect(() => {
    const handleWindowFocus = (): void => {
      if (
        useSessionStore.getState().focusedSessionId === sessionId &&
        !document.activeElement?.closest('[data-testid="linked-document-panel"]')
      ) {
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
      className={cn('flex flex-col h-full bg-surface-0 transition-shadow', '')}
      onMouseDown={handleClick}
    >
      <TerminalHeader sessionId={sessionId} />
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
        <MessageTrail sessionId={sessionId} />
      </div>
    </div>
  )
}
