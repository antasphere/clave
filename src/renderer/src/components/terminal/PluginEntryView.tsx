import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  PluginRpcRequest,
  PluginViewDescriptor,
  PluginViewEntry,
  PluginViewLease
} from '../../../../shared/runtime-plugins'
import { MarkdownRenderer } from '../files/MarkdownRenderer'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'

/** The frame receives one private port, never an Electron API or a store reference. */
function PluginFrame({
  sessionId,
  entryId,
  view,
  onFailure
}: {
  sessionId: string
  entryId: string
  view?: PluginViewDescriptor
  onFailure: (error: string) => void
}): React.JSX.Element {
  const [lease, setLease] = useState<PluginViewLease>()
  const frame = useRef<HTMLIFrameElement>(null)
  const connect = useRef<() => void>(() => {})
  const failure = useRef(onFailure)
  useEffect(() => {
    failure.current = onFailure
  }, [onFailure])
  useEffect(() => {
    let disposed = false
    let current: PluginViewLease | undefined
    let channel: MessageChannel | undefined
    let loaded = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const stop = (): void => {
      channel?.port1.close()
      channel?.port2.close()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      if (current) void window.electronAPI.runtimePlugins.closeView(current.id).catch(() => {})
      current = undefined
    }
    void window.electronAPI.runtimePlugins
      .openView(sessionId, entryId, view)
      .then((next) => {
        if (disposed) {
          void window.electronAPI.runtimePlugins.closeView(next.id)
          return
        }
        if (!next.url.startsWith('clave-plugin:')) {
          void window.electronAPI.runtimePlugins.closeView(next.id)
          throw new Error('Invalid plugin view URL')
        }
        current = next
        setLease(next)
      })
      .catch((error) => {
        if (!disposed) failure.current(String(error))
      })
    connect.current = () => {
      if (!current || disposed) return
      if (loaded) {
        stop()
        failure.current('The view reloaded. Select it again to reconnect.')
        return
      }
      loaded = true
      const active = current
      channel = new MessageChannel()
      const port = channel.port1
      const ids = new Set<string>()
      const reply = (id: string, value: object): void => {
        if (!disposed && current === active)
          port.postMessage({ type: 'clave:response', id, ...value })
      }
      port.onmessage = (event) => {
        const data = event.data
        if (data?.type === 'clave:view-error') {
          stop()
          failure.current('The view failed. Showing original content.')
          return
        }
        if (
          !data ||
          typeof data !== 'object' ||
          data.type !== 'clave:request' ||
          typeof data.id !== 'string' ||
          data.id.length > 128 ||
          typeof data.method !== 'string'
        )
          return
        let bytes: number
        try {
          bytes = new TextEncoder().encode(JSON.stringify(data)).length
        } catch {
          return
        }
        if (bytes > 65536 || timers.size >= 16 || ids.size >= 4096 || ids.has(data.id)) {
          reply(data.id, { error: 'Request limit exceeded or duplicate request' })
          return
        }
        ids.add(data.id)
        let settled = false
        const timer = setTimeout(() => {
          settled = true
          timers.delete(timer)
          reply(data.id, {
            error: 'Request timed out; its outcome may be unknown. Do not automatically retry.'
          })
        }, 30000)
        timers.add(timer)
        const request: PluginRpcRequest = { id: data.id, method: data.method, params: data.params }
        void window.electronAPI.runtimePlugins
          .request(active.id, request)
          .then((result) => {
            if (!settled) {
              const size = new TextEncoder().encode(JSON.stringify(result) ?? '').length
              reply(data.id, size <= 1048576 ? { result } : { error: 'Response too large' })
            }
          })
          .catch((error) => {
            if (!settled) reply(data.id, { error: String(error) })
          })
          .finally(() => {
            settled = true
            clearTimeout(timer)
            timers.delete(timer)
          })
      }
      frame.current?.contentWindow?.postMessage(
        {
          type: 'clave:init',
          apiVersion: 1,
          entry: active.entry,
          capabilities: active.capabilities
        },
        '*',
        [channel.port2]
      )
    }
    return () => {
      disposed = true
      connect.current = () => {}
      stop()
    }
  }, [sessionId, entryId, view])
  return lease ? (
    <iframe
      ref={frame}
      title="Isolated plugin view"
      sandbox="allow-scripts"
      src={lease.url}
      className="runtime-plugin-frame"
      onLoad={() => connect.current()}
      onError={() => failure.current('Unable to load view')}
    />
  ) : (
    <p>Loading isolated view…</p>
  )
}

export function PluginEntryView({
  sessionId,
  entry,
  children
}: {
  sessionId: string
  entry: PluginViewEntry
  children?: ReactNode
}): React.JSX.Element {
  const [views, setViews] = useState<PluginViewDescriptor[]>([])
  const [selected, setSelected] = useState<PluginViewDescriptor | 'html'>()
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.electronAPI.runtimePlugins
        .views(sessionId, entry.id)
        .then((next) => {
          if (!alive) return
          setViews(next)
          setSelected((old) =>
            old &&
            old !== 'html' &&
            !next.some(
              (v) =>
                v.id === old.id &&
                v.plugin.revision === old.plugin.revision &&
                v.plugin.pluginId === old.plugin.pluginId
            )
              ? undefined
              : old
          )
        })
        .catch(() => {
          if (alive) {
            setViews([])
            setSelected(undefined)
          }
        })
    }
    refresh()
    const off = window.electronAPI.runtimePlugins.onChanged(refresh)
    const open = (event: Event): void => {
      const detail = (event as CustomEvent).detail
      if (detail.sessionId === sessionId && detail.entryId === entry.id) setExpanded(true)
    }
    window.addEventListener('clave:open-artifact', open)
    return () => {
      alive = false
      off()
      window.removeEventListener('clave:open-artifact', open)
    }
  }, [sessionId, entry.id])
  const original =
    children ??
    (entry.kind === 'artifact' ? (
      entry.mimeType === 'text/markdown' ? (
        <MarkdownRenderer content={entry.content} />
      ) : (
        <pre className="whitespace-pre-wrap">
          {entry.mimeType === 'text/html' ? entry.fallback : entry.content}
        </pre>
      )
    ) : null)
  if (entry.kind === 'tool' && !views.length && !selected) return <>{original}</>
  const controls = (
    <div className="conversation-actions">
      <button className="btn-secondary" onClick={() => setSelected(undefined)}>
        View original
      </button>
      {entry.kind === 'artifact' && entry.mimeType === 'text/html' && (
        <button
          className="btn-secondary"
          onClick={() => {
            setError('')
            setSelected('html')
          }}
        >
          Preview HTML (no capabilities)
        </button>
      )}
      {views.map((view) => (
        <button
          className="btn-secondary"
          key={`${view.plugin.pluginId}:${view.id}`}
          title={view.capabilities.join(', ') || 'No capabilities'}
          onClick={() => {
            setError('')
            setSelected(view)
          }}
        >
          {view.name}
        </button>
      ))}
      <button className="btn-secondary" onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Close expanded view' : 'Expand'}
      </button>
    </div>
  )
  const content = (
    <div className="runtime-plugin-content">
      {controls}
      {error && <p role="alert">{error}</p>}
      <div className="runtime-plugin-body">
        {selected ? (
          <PluginFrame
            key={
              selected === 'html'
                ? 'html'
                : `${selected.plugin.pluginId}:${selected.plugin.revision}:${selected.id}`
            }
            sessionId={sessionId}
            entryId={entry.id}
            view={selected === 'html' ? undefined : selected}
            onFailure={(message) => {
              setError(message)
              setSelected(undefined)
            }}
          />
        ) : (
          original
        )}
      </div>
    </div>
  )
  return (
    <section data-artifact-id={entry.id} className="conversation-message runtime-plugin-entry">
      {entry.kind === 'artifact' && <h3>{entry.title}</h3>}
      {!expanded && content}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="runtime-plugin-dialog">
          <DialogTitle>{entry.kind === 'artifact' ? entry.title : entry.name}</DialogTitle>
          {expanded && content}
        </DialogContent>
      </Dialog>
    </section>
  )
}
