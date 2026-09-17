import { useSessionStore, type Session } from '../../store/session-store'
import { ensureSessionViewServer } from '../../lib/session-view'
import { WebViewPane } from './WebViewPane'

/**
 * A session's attached web view (session.view) — shown in place of the
 * terminal grid when the row's dashboard icon is clicked; "back" (or clicking
 * the row itself) returns to the terminal. The start action respawns the
 * hidden serving session from the view's stored command, so a view survives
 * its server: after a restart the probe finds the page down and the pane
 * brings it back unasked (the command was attached to be run). The serving
 * session is hidden by design, so there is no terminal to show here.
 */
export function SessionViewPanel({
  session,
  active = true
}: {
  session: Session
  /** False while this pane is mounted but hidden behind another. */
  active?: boolean
}): React.JSX.Element | null {
  const setActiveSessionView = useSessionStore((s) => s.setActiveSessionView)
  const view = session.view
  if (!view) return null

  return (
    <WebViewPane
      url={view.url}
      title={view.title || session.name}
      backLabel="Terminal"
      active={active}
      onBack={() => setActiveSessionView(null)}
      start={
        view.command
          ? {
              command: view.command,
              run: () => ensureSessionViewServer(session.id),
              auto: true
            }
          : null
      }
    />
  )
}
