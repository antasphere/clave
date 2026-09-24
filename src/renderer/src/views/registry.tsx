import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { useRegistry } from './store'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ChatBubbleLeftRightIcon,
  CheckIcon,
  CommandLineIcon,
  Squares2X2Icon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import type { AgentState } from '../../../shared/session-model'
import { ChatView, type ChatViewProps } from '../../../../plugins/chat-view/src/ChatView'
import { CompactView } from '../../../../plugins/chat-view/src/CompactView'
import { TerminalPanel } from '../components/terminal/TerminalPanel'
import { useViewSessionStore } from './session-store'
import { bindKernelState } from './kernel-state'
import { useSessionLog } from './conversation-store'
import { PluginViewSurface } from './PluginViewSurface'
import { availableViews, resolveView, type AvailableView } from './resolution'
import { emitTabClosed } from '../lib/exchange-capture'
import { ConfirmDialog } from '@clave/ui/components'

/** Bundled native views, keyed by the id a session carries: `<pluginId>/<viewId>`.
 *  A plugin contributing several views has one entry per view, which is what
 *  lets the picker offer them and a session name one. */
const nativeViews: Record<string, ComponentType<ChatViewProps>> = {
  'clave.chat-view/chat': ChatView,
  'clave.chat-view/compact': CompactView
}
/** What this build can mount, handed to the pure resolution in `resolution.ts`. */
const implemented: ReadonlySet<string> = new Set(Object.keys(nativeViews))
type DotStatus = 'working' | 'waiting' | 'ready' | 'inactive'
function dotStatus(state: string): DotStatus {
  if (state === 'working') return 'working'
  if (state === 'blocked') return 'waiting'
  if (state === 'ended') return 'inactive'
  return 'ready'
}
export function SessionViewBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const registry = useRegistry()
  const record = registry.sessions.find((s) => s.id === sessionId)
  if (record?.transport !== 'events') return null
  const chat =
    resolveView(record, registry.plugins, implemented) && !registry.terminal.has(sessionId)
  const Icon = chat ? ChatBubbleLeftRightIcon : CommandLineIcon
  return (
    <span
      className="chat-view-badge"
      title={chat ? 'Chat view' : 'Terminal view'}
      aria-label={chat ? 'Chat view' : 'Terminal view'}
    >
      <Icon />
    </span>
  )
}
/** The pane's view picker: every view that renders this session, the current
 *  one checked. Hidden when a session has only one view to be read in — a menu
 *  with a single item is chrome with nothing to decide. */
function ViewPicker({
  sessionId,
  views,
  active
}: {
  sessionId: string
  views: AvailableView[]
  active: string | undefined
}): React.JSX.Element | null {
  const [failure, setFailure] = useState('')
  if (views.length < 2) return null
  const current = views.find((view) => view.id === active)
  const choose = async (id: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.sessionsSetView(sessionId, id)
      // The record in main is the truth; reflect it without waiting for a
      // round trip through the plugin-change refresh.
      useRegistry.setState((state) => ({
        sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s))
      }))
      setFailure('')
    } catch (error) {
      setFailure(String(error))
    }
  }
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label="Change view"
          title={failure || `View: ${current?.title ?? 'default'}`}
          data-failed={failure ? 'true' : undefined}
        >
          <Squares2X2Icon className="w-4 h-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop z-50"
          aria-label="Views"
        >
          <DropdownMenu.Label className="menu-label">Read this session as</DropdownMenu.Label>
          {views.map((view) => (
            <DropdownMenu.Item
              key={view.id}
              className="menu-item"
              data-selected={view.id === active ? 'true' : undefined}
              onSelect={() => void choose(view.id)}
            >
              <span className="truncate">{view.title}</span>
              {view.id === active && <CheckIcon className="select-option-check" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
export function RegisteredSessionView({
  sessionId,
  terminalSessionId
}: {
  sessionId: string
  terminalSessionId?: string
}): React.JSX.Element {
  const registry = useRegistry()
  const session = registry.sessions.find((s) => s.id === sessionId)
  const views = availableViews(session, registry.plugins, implemented)
  const viewId = resolveView(session, registry.plugins, implemented)
  // The host keeps the session's event log while a view is mounted on it, so a
  // view that reads the log renders the whole conversation however late it is
  // opened. It is held on `viewId`, not on the transport: with no view resolved
  // the pane falls back to the terminal, and a claim kept there would never
  // reach zero — main would go on streaming into a log nobody reads.
  useSessionLog(session?.transport === 'events' && viewId ? sessionId : '')
  // Every view this session can be read in is mounted for the pane's lifetime
  // and all but one are hidden. Switching therefore finds a view exactly as it
  // was left — including the state a view keeps privately rather than reading
  // from the host's log, which is what a transcript is today.
  const mounted = views.map((view) => view.id)
  const mountedKey = mounted.join('|')
  const [showConfirm, setShowConfirm] = useState(false)
  // Each mounted view reports its own state; the header reads the one on screen.
  // A hidden view can therefore keep reporting without ever overwriting what the
  // reader sees, and switching shows that view's own last word immediately.
  const [metaByView, setMetaByView] = useState<
    Record<string, { state: string; model: string | null }>
  >({})
  const meta = (viewId ? metaByView[viewId] : undefined) ?? {
    state: session?.state ?? 'idle',
    model: null
  }
  // Views may report presentation metadata, but only the kernel owns sidebar
  // state. One reporter per mounted view, stable for as long as the set of
  // mounted views is, so a view's own effect is not re-fired by a re-render.
  const reporters = useMemo(() => {
    const map = new Map<string, (state: AgentState, model: string | null) => void>()
    for (const id of mounted)
      map.set(id, (state: AgentState, model: string | null): void =>
        setMetaByView((current) =>
          current[id]?.state === state && current[id]?.model === model
            ? current
            : { ...current, [id]: { state, model } }
        )
      )
    return map
    // The identities must survive a re-render; only a change in WHICH views are
    // mounted may replace them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedKey])
  const transport = session?.transport
  useEffect(() => {
    if (transport !== 'events') return
    const stopKernel = bindKernelState(
      sessionId,
      {
        onAgentState: (id, callback) => window.electronAPI.onAgentState(id, callback),
        sessionsList: () => window.electronAPI.sessionsList()
      },
      {
        isAlive: (id) => useViewSessionStore.getState().sessions.find((s) => s.id === id)?.alive,
        setAlive: (id, alive) => useViewSessionStore.getState().updateSessionAlive(id, alive),
        setState: (id, state) => useViewSessionStore.getState().setAgentState(id, state)
      }
    )
    // A chat tab is named by its first message: main asks for the title when
    // the message crosses `sessions:write` and answers on the channel a
    // terminal tab's title arrives on. The pane stays mounted, hidden, while
    // another tab is active, so this listener lives as long as the tab does.
    const stopTitle = window.electronAPI.onSessionAutoTitle(sessionId, (title) =>
      useViewSessionStore.getState().autoRenameSession(sessionId, title)
    )
    return () => {
      stopKernel()
      stopTitle()
    }
  }, [sessionId, transport])
  const close = async (): Promise<void> => {
    const current = useViewSessionStore.getState()
    const closing = current.sessions.find((s) => s.id === sessionId)
    if (closing) emitTabClosed(closing, current.groups, 'user', null)
    try {
      await window.electronAPI.killSession(sessionId)
    } catch {
      // The provider may already have exited, as in the terminal header.
    }
    useViewSessionStore.getState().removeSession(sessionId)
    setShowConfirm(false)
  }
  // v1 describes exactly one transport. A future dual-transport record can pass
  // its PTY session id here without changing the view plugin's bridge.
  const terminal = registry.terminal.has(sessionId)
  const name = useViewSessionStore((s) => s.sessions.find((r) => r.id === sessionId)?.name)
  // The terminal is the fallback when nothing resolves — not when the resolved
  // view happens to be a surface one, which has no entry in the native map.
  if (!session || session.transport === 'pty' || !viewId)
    return <TerminalPanel sessionId={sessionId} />
  return (
    <section
      className="chat-host"
      // Which session this pane is showing, so a test can tell two panes apart
      // without counting them.
      data-session-id={sessionId}
      onPointerDown={() => useViewSessionStore.getState().setFocusedSession(sessionId)}
    >
      <header className="pane-header chat-header">
        <div className="pane-header-lead">
          <span className="pane-status-dot" data-status={dotStatus(meta.state)} />
          <span className="pane-header-title" title={session.cwd}>
            {name ?? session.title}
          </span>
          {meta.model && (
            <span className="pane-header-meta" title="Model">
              {meta.model}
            </span>
          )}
        </div>
        <div className="pane-header-actions">
          <span className="chat-state" data-state={meta.state}>
            {meta.state}
          </span>
          <ViewPicker sessionId={sessionId} views={views} active={viewId} />
          <span
            title={
              terminalSessionId
                ? terminal
                  ? 'Show chat'
                  : 'Show terminal'
                : 'This events session has no PTY terminal'
            }
          >
            <button
              className="panel-icon-btn"
              aria-label={terminal ? 'Show chat' : 'Show terminal'}
              disabled={!terminalSessionId}
              data-active={terminal}
              onClick={() =>
                useRegistry.setState({
                  terminal: new Set(
                    terminal
                      ? [...registry.terminal].filter((id) => id !== sessionId)
                      : [...registry.terminal, sessionId]
                  )
                })
              }
            >
              <CommandLineIcon className="w-4 h-4" />
            </button>
          </span>
          <button
            className="panel-icon-btn"
            aria-label="Close session"
            title="Close session"
            onClick={() => setShowConfirm(true)}
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>
      </header>
      {views.map((view) => {
        const Mounted = nativeViews[view.id]
        const hidden = view.id !== viewId || (terminal && !!terminalSessionId)
        // A surface view is the plugin's own page and costs a lease and a
        // process, so it mounts only while it is the view on screen; a native
        // view is cheap and stays mounted to keep what it holds privately.
        if (view.kind === 'surface' && hidden) return null
        return (
          <div key={view.id} className="chat-content-slot" data-view-id={view.id} hidden={hidden}>
            {view.kind === 'surface' ? (
              <PluginViewSurface
                key={`${view.id}:${session.id}`}
                pluginId={view.id.slice(0, view.id.lastIndexOf('/'))}
                viewId={view.id.slice(view.id.lastIndexOf('/') + 1)}
                session={session}
                onState={reporters.get(view.id)!}
              />
            ) : Mounted ? (
              <Mounted session={session} onState={reporters.get(view.id)!} />
            ) : null}
          </div>
        )
      })}
      {terminal && terminalSessionId && <TerminalPanel sessionId={terminalSessionId} />}
      <ConfirmDialog
        isOpen={showConfirm}
        title="Delete session"
        message="Are you sure you want to delete this session? This will terminate the process. The conversation is not saved."
        onConfirm={() => void close()}
        onCancel={() => setShowConfirm(false)}
      />
    </section>
  )
}
