import { useCallback, useEffect, useState, type ComponentType } from 'react'
import { useRegistry } from './store'
import { ChatBubbleLeftRightIcon, CommandLineIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { Session, AgentState } from '../../../shared/session-model'
import type { PluginRecord } from '../../../main/plugins/plugin-store'
import { ChatView, type ChatViewProps } from '../../../../plugins/chat-view/src/ChatView'
import { TerminalPanel } from '../components/terminal/TerminalPanel'
import { useViewSessionStore } from './session-store'
import { bindKernelState } from './kernel-state'
import { emitTabClosed } from '../lib/exchange-capture'
import { ConfirmDialog } from '@clave/ui/components'

const nativeViews: Record<string, ComponentType<ChatViewProps>> = { 'clave.chat-view': ChatView }
type DotStatus = 'working' | 'waiting' | 'ready' | 'inactive'
function dotStatus(state: string): DotStatus {
  if (state === 'working') return 'working'
  if (state === 'blocked') return 'waiting'
  if (state === 'ended') return 'inactive'
  return 'ready'
}
function resolveView(session: Session | undefined, plugins: PluginRecord[]): string | undefined {
  if (!session || session.transport !== 'events') return undefined
  const plugin = plugins.find(
    (p) =>
      p.source === 'bundled' &&
      p.enabled &&
      p.status === 'active' &&
      !p.error &&
      p.permissionsGranted.includes('sessions.read') &&
      p.permissionsGranted.includes('sessions.write') &&
      p.manifest?.ui === 'native' &&
      p.manifest.contributes.views.some((view) => view.renders.includes(session.transport)) &&
      nativeViews[p.id]
  )
  return plugin?.id
}
export function SessionViewBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const registry = useRegistry()
  const record = registry.sessions.find((s) => s.id === sessionId)
  if (record?.transport !== 'events') return null
  const chat = resolveView(record, registry.plugins) && !registry.terminal.has(sessionId)
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
export function RegisteredSessionView({
  sessionId,
  terminalSessionId
}: {
  sessionId: string
  terminalSessionId?: string
}): React.JSX.Element {
  const registry = useRegistry()
  const session = registry.sessions.find((s) => s.id === sessionId)
  const viewId = resolveView(session, registry.plugins)
  const View = viewId ? nativeViews[viewId] : undefined
  const [showConfirm, setShowConfirm] = useState(false)
  const [meta, setMeta] = useState<{ state: string; model: string | null }>({
    state: 'idle',
    model: null
  })
  // Views may report presentation metadata, but only the kernel owns sidebar state.
  const onState = useCallback((state: AgentState, model: string | null): void => {
    setMeta({ state, model })
  }, [])
  const transport = session?.transport
  useEffect(() => {
    if (transport !== 'events') return
    return bindKernelState(
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
  if (!session || session.transport === 'pty' || !View)
    return <TerminalPanel sessionId={sessionId} />
  return (
    <section
      className="chat-host"
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
      <div className="chat-content-slot" hidden={terminal && !!terminalSessionId}>
        <View session={session} onState={onState} />
      </div>
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
