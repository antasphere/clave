import { useEffect, useState } from 'react'
import { XMarkIcon, TrashIcon } from '@heroicons/react/24/outline'
import type { PluginRecord } from '../../../../main/plugins/plugin-store'
import type { PluginSecretPrompt } from '../../../../preload/index.d'
import { PluginSurface } from '../plugins/PluginSurface'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsCallout,
  Toggle
} from './primitives'

export function PluginsTab(): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginRecord[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<string | null>(null)
  const [panel, setPanel] = useState<{
    pluginId: string
    panelId: string
    generation: number
    url: string
    title: string
  } | null>(null)
  const [prompts, setPrompts] = useState<PluginSecretPrompt[]>([])
  const [secret, setSecret] = useState('')
  const refresh = async (): Promise<void> => {
    const [records, pending] = await Promise.all([
      window.electronAPI.pluginsList(),
      window.electronAPI.pluginsSecrets()
    ])
    setPlugins(records)
    setPrompts(pending)
    setPanel((current) =>
      current &&
      records.some(
        (r) =>
          r.id === current.pluginId &&
          r.enabled &&
          r.status === 'active' &&
          r.generation === current.generation &&
          r.panels.includes(current.panelId)
      )
        ? current
        : null
    )
  }
  useEffect(() => {
    let mounted = true
    const update = (): void => {
      if (mounted) void refresh().catch((error) => setError(String(error)))
    }
    update()
    const off = window.electronAPI.onPluginsChanged(update)
    return () => {
      mounted = false
      off()
    }
  }, [])
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsPage
      title="Plugins"
      description="Panels, commands, and tools installed in Clave."
      actions={
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() => void run(() => window.electronAPI.pluginsLink())}
        >
          Link folder…
        </button>
      }
    >
      {error && <SettingsCallout tone="danger" title="Plugin error" text={error} />}
      <SettingsSection
        title="Installed plugins"
        description="Review host API permissions before enabling a plugin. Host code runs on your machine; link folders you trust."
      >
        <SettingsCard>
          {plugins.length === 0 && <SettingsRow label="No plugins installed" />}
          {plugins.map((plugin) => (
            <div key={plugin.id} data-plugin-id={plugin.id}>
              <SettingsRow
                label={plugin.manifest?.name ?? plugin.id}
                description={`${plugin.manifest?.kind ?? 'Invalid manifest'} · ${plugin.version} · ${plugin.source} · ${plugin.status}${plugin.needsReview ? ' · Needs review before enabling' : ''}`}
              >
                <Toggle
                  checked={plugin.enabled && !!plugin.manifest}
                  disabled={busy || !plugin.manifest || (!!plugin.error && !plugin.enabled)}
                  ariaLabel={`Enable ${plugin.manifest?.name ?? plugin.id}`}
                  onChange={(enabled) =>
                    enabled
                      ? setReview(plugin.id)
                      : void run(() => window.electronAPI.pluginsDisable(plugin.id))
                  }
                />
                {plugin.source !== 'bundled' && (
                  <button
                    className="btn-icon btn-icon-sm btn-icon--danger"
                    title={`Remove ${plugin.manifest?.name ?? plugin.id}`}
                    disabled={busy}
                    onClick={() => void run(() => window.electronAPI.pluginsRemove(plugin.id))}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                )}
              </SettingsRow>
              <SettingsRow
                label="Permissions"
                description={
                  plugin.manifest?.permissions.join(', ') || 'No privileged host API permissions'
                }
              />
              {plugin.error && <SettingsCallout tone="danger" text={plugin.error} />}
              {review === plugin.id && (
                <SettingsCallout
                  title={`Enable ${plugin.manifest?.name}?`}
                  tone={plugin.manifest?.contributes.adapters.length ? 'danger' : undefined}
                  text={`Host API permissions: ${plugin.manifest?.permissions.join(', ') || 'none'}. ${
                    plugin.manifest?.contributes.adapters.length
                      ? 'This plugin supplies an agent, and an agent\u2019s code runs INSIDE Clave, in the same process as the app, with everything Clave itself can reach: your full environment including any credentials in it, your files, and the ability to start other programs. Enable it only if you trust its author as much as you trust Clave.'
                      : 'The plugin runs as a separate process with a trimmed environment. It can read and write your files.'
                  } These permissions govern Clave host APIs, not OS access.`}
                >
                  <button className="btn-dialog" onClick={() => setReview(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.electronAPI.pluginsEnable(
                          plugin.id,
                          plugin.manifest!.permissions
                        )
                        setReview(null)
                      })
                    }
                  >
                    Enable plugin
                  </button>
                </SettingsCallout>
              )}
              {plugin.status === 'active' &&
                plugin.manifest?.contributes.panels
                  .filter((p) => plugin.panels.includes(p.id))
                  .map((p) => (
                    <SettingsRow key={p.id} label={p.title} description={`${p.placement} panel`}>
                      <button
                        className="btn-secondary"
                        disabled={busy || plugin.manifest?.ui !== 'surface'}
                        onClick={() =>
                          void run(async () => {
                            const { url } = await window.electronAPI.pluginsPanel(plugin.id, p.id)
                            setPanel({
                              pluginId: plugin.id,
                              panelId: p.id,
                              generation: plugin.generation,
                              url,
                              title: p.title
                            })
                          })
                        }
                      >
                        Open {p.title}
                      </button>
                    </SettingsRow>
                  ))}
              {plugin.status === 'active' &&
                plugin.manifest?.contributes.commands
                  .filter((c) => plugin.commands.includes(c.id))
                  .map((c) => (
                    <SettingsRow key={c.id} label={c.title} description={c.keybinding}>
                      <button
                        className="btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(() => window.electronAPI.pluginsCommand(plugin.id, c.id))
                        }
                      >
                        Run {c.title}
                      </button>
                    </SettingsRow>
                  ))}
              {plugin.lastNotification && (
                <SettingsCallout
                  title={plugin.lastNotification.title}
                  text={plugin.lastNotification.body}
                />
              )}
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
      {panel && (
        <aside
          className="floating-card flex flex-col aspect-video"
          data-plugin-panel={panel.panelId}
        >
          <div className="flex items-center shrink-0 px-0.5">
            <span className="panel-tab">{panel.title}</span>
            <button
              className="panel-icon-btn ml-auto"
              aria-label="Close plugin panel"
              onClick={() => setPanel(null)}
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
          <PluginSurface key={panel.url} url={panel.url} title={panel.title} />
        </aside>
      )}
      {prompts.map((prompt) => (
        <SettingsCallout
          key={prompt.id}
          title={`${plugins.find((p) => p.id === prompt.pluginId)?.manifest?.name ?? prompt.pluginId}: ${prompt.title}`}
          text={prompt.description}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const value = secret
              setSecret('')
              void run(() => window.electronAPI.pluginsSecretReply(prompt.id, value))
            }}
          >
            <input
              className="input-field"
              type="password"
              autoComplete="off"
              aria-label={prompt.title}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <button
              className="btn-dialog"
              type="button"
              onClick={() => {
                setSecret('')
                void run(() => window.electronAPI.pluginsSecretReply(prompt.id, null))
              }}
            >
              Cancel
            </button>
            <button className="btn-primary" type="submit" disabled={!secret}>
              Share with plugin
            </button>
          </form>
        </SettingsCallout>
      ))}
    </SettingsPage>
  )
}
