import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowPathIcon, ServerStackIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { mcpServers, mcpActions, statusLabel, without, type McpServer } from './control-panels'

/* The /mcp panel: the MCP servers this session sees, each with its state and
   what can be done about it, in the dock above the composer where the TUI's
   own /mcp menu would be. Headless Claude has no such menu (it answers the
   command with a one-line count), so the panel asks the session's own process
   through its control requests and shows the answer it gets back: the CLI is
   the truth, and every action is followed by a fresh status read. */

/** How often the panel reads the status again while a sign-in is pending. */
const AUTH_POLL_MS = 2_000
/** How long it keeps reading before it leaves the reader to refresh. */
const AUTH_POLL_LIMIT_MS = 120_000

export function McpPanel({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const live = useRef(true)
  const polling = useRef<ReturnType<typeof setInterval> | null>(null)

  const read = useCallback(async (): Promise<McpServer[] | null> => {
    setLoading(true)
    try {
      const answer = await window.electronAPI.sessionsControl(sessionId, { type: 'mcp_status' })
      const list = mcpServers(answer)
      if (live.current) {
        setServers(list)
        setFailure(null)
      }
      return list
    } catch (error) {
      if (live.current) setFailure(String(error))
      return null
    } finally {
      if (live.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    live.current = true
    void read()
    return () => {
      live.current = false
      if (polling.current) clearInterval(polling.current)
    }
  }, [read])

  /** After a sign-in starts, read the status until the server leaves
   *  needs-auth or the limit passes. */
  const watchSignIn = (name: string): void => {
    if (polling.current) clearInterval(polling.current)
    // The panel may have closed while the sign-in request was in flight.
    if (!live.current) return
    const started = Date.now()
    polling.current = setInterval(() => {
      void read().then((list) => {
        const server = list?.find((s) => s.name === name)
        if (
          (server && server.status !== 'needs-auth') ||
          Date.now() - started > AUTH_POLL_LIMIT_MS
        ) {
          if (polling.current) clearInterval(polling.current)
          polling.current = null
        }
      })
    }, AUTH_POLL_MS)
  }

  const act = async (server: McpServer, run: () => Promise<unknown>): Promise<void> => {
    setBusy((b) => ({ ...b, [server.name]: true }))
    setErrors((e) => without(e, server.name))
    try {
      await run()
    } catch (error) {
      if (live.current) setErrors((e) => ({ ...e, [server.name]: String(error) }))
    } finally {
      await read()
      if (live.current) setBusy((b) => without(b, server.name))
    }
  }
  const control = window.electronAPI.sessionsControl
  const toggle = (server: McpServer, enabled: boolean): Promise<void> =>
    act(server, () => control(sessionId, { type: 'mcp_toggle', server: server.name, enabled }))
  const reconnect = (server: McpServer): Promise<void> =>
    act(server, () => control(sessionId, { type: 'mcp_reconnect', server: server.name }))
  const clearAuth = (server: McpServer): Promise<void> =>
    act(server, () => control(sessionId, { type: 'mcp_clear_auth', server: server.name }))
  const authenticate = (server: McpServer): Promise<void> =>
    act(server, async () => {
      const answer = await control(sessionId, { type: 'mcp_authenticate', server: server.name })
      const url = typeof answer.authUrl === 'string' ? answer.authUrl : null
      if (url && /^https?:\/\//.test(url)) await window.electronAPI.openExternal(url)
      watchSignIn(server.name)
    })

  const q = query.trim().toLowerCase()
  const shown = (servers ?? []).filter((s) => !q || s.name.toLowerCase().includes(q))
  return (
    <section
      className="chat-prompt"
      data-kind="mcp"
      aria-label="MCP servers"
      // Escape closes the panel from any of its controls, and stops here: on
      // its way up it would reach the view, which takes it as a stop.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div className="chat-prompt-head">
        <ServerStackIcon className="chat-tool-status" />
        <span className="chat-prompt-title">MCP servers</span>
        <button
          type="button"
          className="chat-turn-copy"
          aria-label="Refresh"
          title="Refresh"
          disabled={loading}
          onClick={() => void read()}
        >
          <ArrowPathIcon />
        </button>
        <button
          type="button"
          className="chat-turn-copy"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          <XMarkIcon />
        </button>
      </div>
      <input
        className="chat-prompt-other chat-resume-search"
        placeholder="Filter servers"
        aria-label="Filter servers"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="chat-resume-list" aria-label="Servers">
        {servers === null && !failure && <div className="chat-model-empty">Loading…</div>}
        {failure && <div className="chat-model-empty">{failure}</div>}
        {servers && servers.length === 0 && (
          <div className="chat-model-empty">No MCP server in this session</div>
        )}
        {servers && servers.length > 0 && shown.length === 0 && (
          <div className="chat-model-empty">No server matches “{query}”</div>
        )}
        {shown.map((server) => {
          const actions = mcpActions(server)
          const working = busy[server.name] === true
          return (
            <div key={server.name} className="chat-control-row" data-busy={working || undefined}>
              <div className="chat-control-text">
                <span className="chat-resume-title">{server.name}</span>
                <span className="chat-resume-meta">
                  <span className="chat-control-status" data-status={server.status}>
                    {statusLabel(server.status)}
                  </span>
                  {server.tools !== null && <span>{server.tools} tools</span>}
                  {server.scope && <span>{server.scope}</span>}
                </span>
                {(errors[server.name] ?? server.error) && (
                  <span className="chat-control-error">{errors[server.name] ?? server.error}</span>
                )}
              </div>
              <div className="chat-control-actions">
                {actions.authenticate && (
                  <button
                    type="button"
                    className="chat-prompt-btn"
                    data-primary="true"
                    disabled={working}
                    onClick={() => void authenticate(server)}
                  >
                    Authenticate
                  </button>
                )}
                {actions.reconnect && (
                  <button
                    type="button"
                    className="chat-prompt-btn"
                    disabled={working}
                    onClick={() => void reconnect(server)}
                  >
                    Reconnect
                  </button>
                )}
                {actions.clearAuth && (
                  <button
                    type="button"
                    className="chat-prompt-btn"
                    disabled={working}
                    onClick={() => void clearAuth(server)}
                  >
                    Sign out
                  </button>
                )}
                <button
                  type="button"
                  role="switch"
                  aria-checked={actions.enabled}
                  aria-label={`${actions.enabled ? 'Disable' : 'Enable'} ${server.name}`}
                  className="switch"
                  data-checked={actions.enabled ? 'true' : undefined}
                  disabled={working}
                  onClick={() => void toggle(server, !actions.enabled)}
                >
                  <span className="switch-knob" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
