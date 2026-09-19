import { useViewRegistry } from '../../views/store'
import { initLinkedDocuments, useLinkedDocumentStore } from '../../store/linked-document-store'
import { LinkedDocumentPanel } from '../files/LinkedDocumentPanel'
import { useEffect, useMemo, useState } from 'react'
import {
  useSessionStore,
  getDisplayOrder,
  isFileTabId,
  inActiveWorkspace
} from '../../store/session-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { RegisteredSessionView } from '../../views/registry'
import { RemoteTerminalPanel } from '../terminal/RemoteTerminalPanel'
import { TerminalErrorBoundary } from '../terminal/TerminalErrorBoundary'
import { FileViewer } from '../files/FileViewer'
import { DiffViewer } from '../files/DiffViewer'
import { EmptyState } from '../ui/EmptyState'
import { GroupViewPanel } from './GroupViewPanel'
import { SessionViewPanel } from './SessionViewPanel'

/**
 * The ids this pane has shown at least once, in order of first appearance.
 *
 * A web view is kept MOUNTED after you look away so its page survives — the
 * scroll offset and the in-page state of a rendered page live in a guest
 * process the app does not read back, so the only way to keep them is never to
 * destroy the document. Mounting is still earned by being opened: a view can
 * point at a dev server, and mounting every attached one at boot would fire
 * those requests for panes nobody asked for.
 */
function useEverShown(activeId: string | null, valid: (id: string) => boolean): string[] {
  // State, not a ref: this is derived during render, and a render can be thrown
  // away. Mutating a ref here would keep the id of a pane that was never
  // committed. Zustand's own "derive, don't effect" pattern, as elsewhere in
  // this codebase (see useFileViewMode).
  const [shown, setShown] = useState<string[]>([])
  const next = activeId && !shown.includes(activeId) ? [...shown, activeId] : shown
  // Drop what is no longer real (group deleted, view detached, workspace
  // switched) so a stale pane cannot linger invisibly holding a frame open.
  const live = next.filter(valid)
  if (live.length !== shown.length || live.some((id, i) => id !== shown[i])) setShown(live)
  return live
}

function computeGridLayout(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 }
  if (count === 2) return { cols: 2, rows: 1 }
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  return { cols, rows }
}

export function TerminalGrid(): React.JSX.Element {
  useViewRegistry()
  const linked = useLinkedDocumentStore((s) => s.documents)
  useEffect(() => initLinkedDocuments(), [])
  const selectedSessionIds = useSessionStore((s) => s.selectedSessionIds)
  const sessions = useSessionStore((s) => s.sessions)
  useEffect(() => {
    void useLinkedDocumentStore.getState().refresh().catch(console.error)
  }, [sessions.length])
  const fileTabs = useSessionStore((s) => s.fileTabs)
  const groups = useSessionStore((s) => s.groups)
  const displayOrder = useSessionStore((s) => s.displayOrder)
  const activeGroupViewId = useSessionStore((s) => s.activeGroupViewId)
  const activeSessionViewId = useSessionStore((s) => s.activeSessionViewId)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  // Re-validate the active group view — the id may be stale (group deleted,
  // view detached, workspace switched); a stale id silently falls back to the grid.
  const viewGroup =
    (activeGroupViewId &&
      groups.find(
        (g) => g.id === activeGroupViewId && g.view && inActiveWorkspace(g, activeWorkspaceId)
      )) ||
    null

  // Same re-validation for a session's view — the id may be stale (session
  // closed, view detached, workspace switched); stale falls back to the grid.
  const viewSession =
    (activeSessionViewId &&
      sessions.find(
        (s) => s.id === activeSessionViewId && s.view && inActiveWorkspace(s, activeWorkspaceId)
      )) ||
    null

  // Every view this pane has opened stays mounted; only the active one is
  // visible. Validity is re-checked on each render against the same conditions
  // that gate the active one, so a pane whose group or session went away, lost
  // its view, or left the workspace is unmounted rather than kept alive hidden.
  const mountedViewGroups = useEverShown(activeGroupViewId, (id) =>
    groups.some((g) => g.id === id && g.view && inActiveWorkspace(g, activeWorkspaceId))
  ).map((id) => groups.find((g) => g.id === id)!)
  const mountedViewSessions = useEverShown(activeSessionViewId, (id) =>
    sessions.some((s) => s.id === id && s.view && inActiveWorkspace(s, activeWorkspaceId))
  ).map((id) => sessions.find((s) => s.id === id)!)

  const orderedSessions = useMemo(() => {
    const order = getDisplayOrder({ sessions, groups, displayOrder })
    const sessionMap = new Map(sessions.map((s) => [s.id, s]))
    const placed = new Set<string>()
    const result: typeof sessions = []
    for (const id of order) {
      const group = groups.find((g) => g.id === id)
      if (group) {
        for (const sid of group.sessionIds) {
          const session = sessionMap.get(sid)
          if (session) {
            result.push(session)
            placed.add(sid)
          }
        }
      } else {
        const session = sessionMap.get(id)
        if (session) {
          result.push(session)
          placed.add(id)
        }
      }
    }
    // Include hidden terminal sessions (not in displayOrder or group.sessionIds)
    for (const s of sessions) {
      if (!placed.has(s.id)) result.push(s)
    }
    return result
  }, [sessions, groups, displayOrder])

  // Separate selected items into sessions, file tabs, and agent sessions
  const agentSessionIds = new Set(
    sessions.filter((s) => s.sessionType === 'agent').map((s) => s.id)
  )
  const selectedFileTabIds = selectedSessionIds.filter((id) => isFileTabId(id))
  const selectedTerminalIds = selectedSessionIds.filter(
    (id) => !isFileTabId(id) && !agentSessionIds.has(id)
  )

  const linkedActive =
    selectedSessionIds.length === 1 && !viewGroup && !viewSession
      ? linked.find((d) => d.sessionId === selectedSessionIds[0] && !d.hidden)
      : undefined

  if (sessions.length === 0 && fileTabs.length === 0) {
    return <EmptyState />
  }

  // Don't count agent sessions in the grid layout
  const hasSelection = selectedSessionIds.length > 0
  const visibleCount = selectedTerminalIds.length + selectedFileTabIds.length
  const { cols, rows } = computeGridLayout(visibleCount)

  return (
    <div className="flex-1 relative overflow-hidden">
      {/* "Select a session" overlay when nothing is selected */}
      {!hasSelection && !viewGroup && !viewSession && (
        <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-sm z-10">
          Select a session
        </div>
      )}

      {/* A group's attached web view replaces the mosaic; the grid below stays
          mounted (hidden) so every terminal keeps running.

          Every view opened this session stays mounted and the inactive ones are
          hidden, for the reason the file tabs below are: unmounting a pane
          destroys its page, and a rendered .html loses its scroll and its
          in-page state with it. `pointerEvents: none` keeps a hidden pane from
          swallowing clicks meant for what is actually on top, and the pane it
          covers is `aria-hidden` so a screen reader is not offered two copies
          of the same page. */}
      {mountedViewGroups.map((g) => (
        <div
          key={g.id}
          className="absolute inset-0"
          style={
            g.id === viewGroup?.id ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
          }
          aria-hidden={g.id === viewGroup?.id ? undefined : true}
        >
          <GroupViewPanel group={g} active={g.id === viewGroup?.id} />
        </div>
      ))}

      {/* A session's attached web view replaces its terminal the same way;
          the grid below stays mounted (hidden) so the terminal keeps running.
          The two are mutually exclusive: setting either active id clears the
          other (see session-store) — so a session pane is visible only when no
          group view is showing. */}
      {mountedViewSessions.map((s) => (
        <div
          key={s.id}
          className="absolute inset-0"
          style={
            !viewGroup && s.id === viewSession?.id
              ? undefined
              : { visibility: 'hidden', pointerEvents: 'none' }
          }
          aria-hidden={!viewGroup && s.id === viewSession?.id ? undefined : true}
        >
          <SessionViewPanel session={s} active={!viewGroup && s.id === viewSession?.id} />
        </div>
      ))}

      {linked.map((doc) => (
        <div
          key={doc.id}
          className="linked-document-slot"
          style={{
            left: `${doc.split * 100}%`,
            display: linkedActive?.id === doc.id ? undefined : 'none'
          }}
        >
          <div
            className="linked-document-divider"
            role="separator"
            aria-label="Resize linked document"
            aria-orientation="vertical"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                void window.electronAPI.linkedDocuments.update(doc.id, doc.revision, {
                  split: Math.max(
                    0.25,
                    Math.min(0.75, doc.split + (event.key === 'ArrowLeft' ? -0.05 : 0.05))
                  )
                })
              }
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              const parent = event.currentTarget.parentElement?.parentElement
              if (!parent) return
              const bounds = parent.getBoundingClientRect()
              const move = (e: PointerEvent): void => {
                void window.electronAPI.linkedDocuments
                  .update(doc.id, doc.revision, {
                    split: Math.max(0.25, Math.min(0.75, (e.clientX - bounds.left) / bounds.width))
                  })
                  .catch(console.error)
              }
              const up = (): void => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
              }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
            }}
          />
          <LinkedDocumentPanel document={doc} />
        </div>
      ))}
      {selectedSessionIds.length === 1 &&
        linked.find((d) => d.sessionId === selectedSessionIds[0] && d.hidden) && (
          <button
            className="panel-tab linked-document-reopen"
            onClick={() => {
              const doc = linked.find((d) => d.sessionId === selectedSessionIds[0])!
              void window.electronAPI.linkedDocuments.update(doc.id, doc.revision, {
                hidden: false
              })
            }}
          >
            Open linked document
          </button>
        )}

      {/* Grid renders ALL terminals and ALL file tabs to keep them alive; the
          unselected ones are hidden (see each loop below). */}
      <div
        className="h-full grid gap-2"
        style={{
          width: linkedActive ? `${linkedActive.split * 100}%` : '100%',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          // EITHER view hides the mosaic, and `visibility` (not `display`) is
          // what keeps every terminal mounted and sized behind it.
          //
          // A session view without this looked broken in a way the DOM denied:
          // the panel rendered, its header showed, and the terminal still
          // covered the page. The panel is `absolute` with z-index auto, so it
          // paints in the positioned layer — but so does xterm, whose own
          // wrappers are `position: relative`, and among z-index-auto siblings
          // DOM order wins. The grid comes second, so the terminal painted over
          // the view's body while leaving its header visible. The group-view
          // path never showed it because it has always hidden the grid.
          ...(viewGroup || viewSession ? { visibility: 'hidden' as const } : {})
        }}
      >
        {orderedSessions.map((session) => {
          // Agent sessions use AgentChatPanel via activeView, skip entirely
          if (session.sessionType === 'agent') return null
          const isSelected = selectedTerminalIds.includes(session.id)
          return (
            <div
              key={session.id}
              className="min-h-0 min-w-0 h-full floating-card"
              style={{ display: isSelected ? undefined : 'none' }}
            >
              <TerminalErrorBoundary sessionId={session.id}>
                {(session.sessionType === 'remote-terminal' ||
                  session.sessionType === 'remote-claude') &&
                session.locationId &&
                session.shellId ? (
                  <RemoteTerminalPanel
                    sessionId={session.id}
                    shellId={session.shellId}
                    locationId={session.locationId}
                  />
                ) : session.locationId && session.locationId !== 'local' && session.shellId ? (
                  <RemoteTerminalPanel
                    sessionId={session.id}
                    shellId={session.shellId}
                    locationId={session.locationId}
                  />
                ) : (
                  <RegisteredSessionView sessionId={session.id} />
                )}
              </TerminalErrorBoundary>
            </div>
          )
        })}
        {/* Like the terminals above, EVERY file tab renders and the unselected
            ones are hidden — a file tab that unmounts loses its live state, and
            for a rendered .html page that state is the whole point: the scroll
            offset, the open in-page tab, the chart's zoom. The page lives in a
            guest process the app does not read back, so none of it can be read
            out and restored; the only way to keep it is to never destroy the
            document.

            What saves the page is staying MOUNTED — measured, not assumed:
            hiding with `display: none` preserves the document and its scroll
            just as well, and the spec's identity and load-count assertions stay
            green under it. `visibility` is chosen for the lesser reason, that
            `display: none` drops the layout box, so the frame comes back at a
            fresh size and any page that lays itself out on resize (a chart, a
            virtualized list) redoes that work on every switch. Keeping the box
            means returning to the tab costs nothing.

            The hidden tile is taken out of grid flow so it cannot claim a cell
            (`visibleCount` counts the selected ones only) and is stretched over
            the pane rather than left to collapse to zero, which would give away
            the box the `visibility` choice is there to keep. */}
        {fileTabs.map((fileTab) => {
          const isSelected = selectedFileTabIds.includes(fileTab.id)
          return (
            <div
              key={fileTab.id}
              className="min-h-0 min-w-0 h-full floating-card"
              style={
                isSelected
                  ? undefined
                  : {
                      visibility: 'hidden' as const,
                      pointerEvents: 'none' as const,
                      position: 'absolute' as const,
                      inset: 0
                    }
              }
              aria-hidden={isSelected ? undefined : true}
            >
              {fileTab.kind === 'diff' ? (
                <DiffViewer fileTab={fileTab} />
              ) : (
                <FileViewer fileTab={fileTab} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
