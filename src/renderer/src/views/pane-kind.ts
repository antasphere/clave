import { useMemo } from 'react'
import { useRegistry } from './store'
import { implemented } from './native-views'
import { resolveView } from './resolution'

type RegistryState = ReturnType<typeof useRegistry.getState>

/** Whether a session's pane is a terminal: the fallback when no view resolves
 *  for it. RegisteredSessionView renders by this rule, and TerminalGrid reads
 *  it to hide a terminal pane differently from a view pane (see its tile loop). */
export function paneIsTerminal(registry: RegistryState, sessionId: string): boolean {
  const session = registry.sessions.find((s) => s.id === sessionId)
  return (
    !session || session.transport === 'pty' || !resolveView(session, registry.plugins, implemented)
  )
}

/** The sessions whose pane is a view rather than a terminal. Selected as one
 *  string, so a registry update that changes no pane re-renders nothing. */
export function useViewPaneIds(): ReadonlySet<string> {
  const key = useRegistry((r) =>
    r.sessions
      .filter((s) => !paneIsTerminal(r, s.id))
      .map((s) => s.id)
      .join('\n')
  )
  return useMemo(() => new Set(key ? key.split('\n') : []), [key])
}
