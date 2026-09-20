import { useCallback, useEffect, useState, type ComponentType } from 'react'
import { useRegistry } from './store'
import { ChatBubbleLeftRightIcon, CommandLineIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { Session, AgentState } from '../../../shared/session-model'
import type { PluginRecord } from '../../../main/plugins/plugin-store'
import { ChatView, type ChatViewProps } from '../../../../plugins/chat-view/src/ChatView'
import { TerminalPanel } from '../components/terminal/TerminalPanel'
import { useViewSessionStore } from './session-store'
import { emitTabClosed } from '../lib/exchange-capture'
import { ConfirmDialog } from '@clave/ui/components'

const nativeViews: Record<string, ComponentType<ChatViewProps>> = { 'clave.chat-view': ChatView }
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
  const focused = useViewSessionStore((s) => s.focusedSessionId === sessionId)
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
    let active = true
    let receivedState = false
    const applyState = (state: string): void => {
      const store = useViewSessionStore.getState()
      if (state === 'ended') {
        if (store.sessions.find((s) => s.id === sessionId)?.alive)
          store.updateSessionAlive(sessionId, false)
      } else if (
        state === 'idle' ||
        state === 'working' ||
        state === 'blocked' ||
        state === 'done'
      ) {
        store.setAgentState(sessionId, state)
      }
    }
    const stop = window.electronAPI.onAgentState(sessionId, (state) => {
      receivedState = true
      applyState(state)
    })
    // Bind before reading so mounting/remounting cannot miss a transition, and
    // never let an older list response overwrite a state already received live.
    void window.electronAPI
      .sessionsList()
      .then((records) => {
        const record = records.find((s) => s.id === sessionId)
        if (active && !receivedState && record) applyState(record.state)
      })
      .catch(console.error)
    return () => {
      active = false
      stop()
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
  if (!session || session.transport === 'pty' || !View)
    return <TerminalPanel sessionId={sessionId} />
  return (
    <section
      className="chat-host"
      data-focused={focused}
      onPointerDown={() => useViewSessionStore.getState().setFocusedSession(sessionId)}
    >
      <header className="chat-header">
        <span className="chat-header-title">
          {session.provider}
          {meta.model ? ` · ${meta.model}` : ''}
        </span>
        <span className="chat-cwd" title={session.cwd}>
          {session.cwd.replace(/^\/Users\/[^/]+/, '~')}
        </span>
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
            <CommandLineIcon />
          </button>
        </span>
        <button
          className="panel-icon-btn"
          aria-label="Close session"
          onClick={() => setShowConfirm(true)}
        >
          <XMarkIcon />
        </button>
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
