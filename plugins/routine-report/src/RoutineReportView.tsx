import { useEffect } from 'react'
import type { ChatViewProps } from '../../chat-view/src/ChatView'
import { useRoutinesStore } from '../../../src/renderer/src/store/routines-store'
import { RoutineReport } from './RoutineReport'

/**
 * The session view of a routine run (ADR 0004): given the run's session, it
 * finds the run in the routines store and renders its report, so a run
 * opened as a tab reads as "Routine report" beside "Chat" and "Enclave" in
 * the pane's picker. The host owns the pane; this view owns only the report.
 */
export function RoutineReportView({ session, onState }: ChatViewProps): React.JSX.Element {
  const routines = useRoutinesStore((s) => s.routines)
  const viewer = useRoutinesStore((s) => s.viewer)
  const view = routines.find((v) =>
    v.runs.some((r) => r.sessionId === session.id || r.discussionSessionId === session.id)
  )
  const run = view?.runs.find(
    (r) => r.sessionId === session.id || r.discussionSessionId === session.id
  )
  // The header reads the kernel's state; this view reports none of its own.
  useEffect(() => {
    onState(session.state, null)
  }, [onState, session.state])
  return (
    <div className="chat-view flex flex-col h-full" data-testid="routine-report-view">
      <RoutineReport view={view} run={run} viewerUrl={viewer.url} viewerNote={viewer.note} />
    </div>
  )
}
