import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowPathIcon, PuzzlePieceIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { PluginInfo } from '../../../src/shared/extensions-types'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'
import { reloadSummary, without } from './control-panels'

/* The /plugin panel: the Claude Code plugins installed on this machine, each
   with a switch and an uninstall, in the dock above the composer where the
   TUI's own /plugin menu would be. A change is written by the CLI's own
   `claude plugin` commands (the ones the Extensions page uses), then the
   session reloads its plugins so it applies to this conversation at once.
   Installing and marketplaces stay on the Extensions page, one click away;
   Reload picks up what was installed there. */

export function PluginPanel({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [reloaded, setReloaded] = useState<{ text: string; failed: boolean } | null>(null)
  const [query, setQuery] = useState('')
  const live = useRef(true)

  const read = useCallback(async (): Promise<void> => {
    try {
      // Every account shares ~/.claude (ADR 0002): one inventory for all.
      const inventory = await window.electronAPI.extensionsGetInventory(undefined)
      if (live.current) {
        setPlugins(inventory.plugins)
        setFailure(null)
      }
    } catch (error) {
      if (live.current) setFailure(String(error))
    }
  }, [])

  useEffect(() => {
    live.current = true
    void read()
    return () => {
      live.current = false
    }
  }, [read])

  const reload = async (): Promise<void> => {
    try {
      const answer = await window.electronAPI.sessionsControl(sessionId, { type: 'reload_plugins' })
      if (live.current) setReloaded(reloadSummary(answer))
    } catch (error) {
      if (live.current) setReloaded({ text: `Reload failed: ${String(error)}`, failed: true })
    }
  }

  /** Run one change, then read the inventory again and reload the session. */
  const change = async (
    plugin: PluginInfo,
    run: () => Promise<{ ok: boolean; message: string }>
  ): Promise<void> => {
    setBusy(plugin.id)
    setConfirming(null)
    setErrors((e) => without(e, plugin.id))
    try {
      const result = await run()
      if (!result.ok) {
        if (live.current) setErrors((e) => ({ ...e, [plugin.id]: result.message }))
        return
      }
      await read()
      await reload()
    } catch (error) {
      if (live.current) setErrors((e) => ({ ...e, [plugin.id]: String(error) }))
    } finally {
      if (live.current) setBusy(null)
    }
  }
  const toggle = (plugin: PluginInfo): Promise<void> =>
    change(plugin, () =>
      window.electronAPI.extensionsSetPluginEnabled(plugin.id, !plugin.enabled, plugin.scope)
    )
  const uninstall = (plugin: PluginInfo): Promise<void> =>
    change(plugin, () => window.electronAPI.extensionsUninstallPlugin(plugin.id, plugin.scope))

  const q = query.trim().toLowerCase()
  const shown = (plugins ?? []).filter(
    (p) =>
      !q || [p.name, p.marketplace, p.description ?? ''].some((t) => t.toLowerCase().includes(q))
  )
  return (
    <section className="chat-prompt" data-kind="plugins" aria-label="Plugins">
      <div className="chat-prompt-head">
        <PuzzlePieceIcon className="chat-tool-status" />
        <span className="chat-prompt-title">Plugins</span>
        <button
          type="button"
          className="chat-turn-copy"
          aria-label="Reload plugins"
          title="Reload this session's plugins"
          disabled={busy !== null}
          onClick={() => {
            setBusy('')
            void Promise.all([read(), reload()]).finally(() => live.current && setBusy(null))
          }}
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
        placeholder="Filter plugins"
        aria-label="Filter plugins"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      />
      <div className="chat-resume-list" aria-label="Installed plugins">
        {plugins === null && !failure && <div className="chat-model-empty">Loading…</div>}
        {failure && <div className="chat-model-empty">{failure}</div>}
        {plugins && plugins.length === 0 && (
          <div className="chat-model-empty">No plugin installed</div>
        )}
        {plugins && plugins.length > 0 && shown.length === 0 && (
          <div className="chat-model-empty">No plugin matches “{query}”</div>
        )}
        {shown.map((plugin) => {
          const working = busy === plugin.id
          return (
            <div key={plugin.id} className="chat-control-row" data-busy={working || undefined}>
              <div className="chat-control-text">
                <span className="chat-resume-title">{plugin.name}</span>
                <span className="chat-resume-meta">
                  <span>{plugin.marketplace}</span>
                  {plugin.version && <span>{plugin.version}</span>}
                  {plugin.scope === 'local' && <span>this project</span>}
                </span>
                {errors[plugin.id] && (
                  <span className="chat-control-error">{errors[plugin.id]}</span>
                )}
              </div>
              <div className="chat-control-actions">
                {confirming === plugin.id ? (
                  <>
                    <button
                      type="button"
                      className="chat-prompt-btn"
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      className="chat-prompt-btn"
                      data-primary="true"
                      onClick={() => void uninstall(plugin)}
                    >
                      Uninstall
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="chat-prompt-btn"
                    disabled={busy !== null}
                    onClick={() => setConfirming(plugin.id)}
                  >
                    Uninstall
                  </button>
                )}
                <button
                  type="button"
                  role="switch"
                  aria-checked={plugin.enabled}
                  aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
                  className="switch"
                  data-checked={plugin.enabled ? 'true' : undefined}
                  disabled={busy !== null}
                  onClick={() => void toggle(plugin)}
                >
                  <span className="switch-knob" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <div className="chat-control-foot">
        {reloaded && (
          <span className="chat-control-note" data-failed={reloaded.failed || undefined}>
            {reloaded.text}
          </span>
        )}
        <button
          type="button"
          className="chat-prompt-btn"
          onClick={() => {
            useSessionStore.getState().openExtensions('marketplaces')
            onClose()
          }}
        >
          Browse and install…
        </button>
      </div>
    </section>
  )
}
