import { useSessionStore, type SessionGroup } from '../../store/session-store'
import { ensureGroupTerminalRunning } from '../../lib/group-terminal'
import { WebViewPane } from './WebViewPane'

/**
 * A group's attached web view (group.view) — shown in place of the tiled
 * session mosaic when the group is clicked. Thin adapter over WebViewPane:
 * the start action runs the group terminal that serves the page, and "back"
 * returns to the mosaic. The probe/header/frame machinery lives in the pane.
 *
 * A terminal the `.clave` declared `auto` starts unasked the first time the
 * pane finds its server down: clicking a project group means "show me the
 * board", not "show me a dead page and a button". "Show terminal" leaves the
 * view for the serving terminal itself — for a board that is a minute of
 * `exos board refresh` before the port answers, the terminal's output is the
 * only honest progress report.
 */
export function GroupViewPanel({
  group,
  active = true
}: {
  group: SessionGroup
  /** False while this pane is mounted but hidden behind another. */
  active?: boolean
}): React.JSX.Element | null {
  const setActiveGroupView = useSessionStore((s) => s.setActiveGroupView)
  const selectSessions = useSessionStore((s) => s.selectSessions)
  const view = group.view
  const linkedTerminal = view?.terminalId
    ? group.terminals.find((t) => t.id === view.terminalId)
    : undefined
  const servingSessionId = linkedTerminal?.sessionId ?? null
  const servingAlive = useSessionStore((s) =>
    servingSessionId ? s.sessions.some((x) => x.id === servingSessionId && x.alive) : false
  )
  if (!view) return null

  return (
    <WebViewPane
      url={view.url}
      title={view.title || group.name}
      backLabel="Sessions"
      active={active}
      onBack={() => setActiveGroupView(null)}
      start={
        linkedTerminal
          ? {
              command: linkedTerminal.command || 'server',
              run: () => ensureGroupTerminalRunning(group.id, linkedTerminal.id),
              auto: linkedTerminal.commandMode === 'auto',
              show:
                servingAlive && servingSessionId
                  ? () => {
                      setActiveGroupView(null)
                      selectSessions([servingSessionId])
                    }
                  : undefined
            }
          : null
      }
    />
  )
}
