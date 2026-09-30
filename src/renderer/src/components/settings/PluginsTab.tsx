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

/** What the row says under the plugin's name: the manifest's facts, in words
 *  a reader scans. The switch beside it already says enabled or disabled, so
 *  the status only speaks up when it is something the switch cannot show. */
function describePlugin(plugin: PluginRecord): string {
  if (!plugin.manifest) return `Invalid manifest · ${plugin.source}`
  const parts = [`v${plugin.version}`, plugin.source]
  if (plugin.status === 'starting') parts.push('Starting…')
  if (plugin.status === 'error') parts.push('Failed to start')
  if (plugin.needsReview) parts.push('Needs review before enabling')
  return parts.join(' · ')
}

/** The consent text: what the plugin asks for and what that lets it do. An
 *  agent plugin runs inside Clave, and the review has to say so before the
 *  grant (plugin-provider.spec.mjs holds this wording). */
function describeReview(plugin: PluginRecord): string {
  const permissions = plugin.manifest?.permissions.join(', ') || 'no host API permissions'
  if (plugin.manifest?.contributes.adapters.length) {
    return `${plugin.manifest.name} supplies an agent, and an agent’s code runs INSIDE Clave, in the same process as the app, with everything Clave itself can reach: your full environment including any credentials in it, your files, and the ability to start other programs. It asks for ${permissions}. Enable it only if you trust its author as much as you trust Clave.`
  }
  // Pinned word for word by plugins.spec.mjs: the caveat about what a host
  // permission is NOT is part of the consent, not decoration.
  return `Host API permissions: ${plugin.manifest?.permissions.join(', ') || 'none'}. The plugin runs as a separate process with a trimmed environment. It can read and write your files. These permissions govern Clave host APIs, not OS access.`
}

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
      description="Panels, commands, agents and tools installed in Clave."
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
        description="A plugin's code runs on your machine. Link only folders you trust, and read what a plugin asks for before enabling it."
      >
        <SettingsCard>
          {plugins.length === 0 && <SettingsRow label="No plugins installed" />}
          {plugins.map((plugin) => {
            const name = plugin.manifest?.name ?? plugin.id
            const permissions = plugin.manifest?.permissions ?? []
            return (
              <div key={plugin.id} data-plugin-id={plugin.id} className="settings-card-group">
                <SettingsRow
                  label={name}
                  description={describePlugin(plugin)}
                  tags={
                    permissions.length > 0 ? (
                      permissions.map((permission) => (
                        <span key={permission} className="badge badge-muted">
                          {permission}
                        </span>
                      ))
                    ) : (
                      <span className="badge badge-muted">No host permissions</span>
                    )
                  }
                >
                  <Toggle
                    checked={plugin.enabled && !!plugin.manifest}
                    disabled={busy || !plugin.manifest || (!!plugin.error && !plugin.enabled)}
                    ariaLabel={`Enable ${name}`}
                    onChange={(enabled) =>
                      enabled
                        ? setReview(plugin.id)
                        : void run(() => window.electronAPI.pluginsDisable(plugin.id))
                    }
                  />
                  {plugin.source !== 'bundled' && (
                    <button
                      className="btn-icon btn-icon-sm btn-icon--danger"
                      title={`Remove ${name}`}
                      disabled={busy}
                      onClick={() => void run(() => window.electronAPI.pluginsRemove(plugin.id))}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </SettingsRow>
                {plugin.error && <SettingsCallout inset tone="danger" text={plugin.error} />}
                {review === plugin.id && (
                  <SettingsCallout
                    inset
                    title={`Enable ${name}?`}
                    tone={plugin.manifest?.contributes.adapters.length ? 'danger' : undefined}
                    text={describeReview(plugin)}
                    actions={
                      <>
                        <button className="btn-secondary" onClick={() => setReview(null)}>
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
                      </>
                    }
                  />
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
                    inset
                    title={plugin.lastNotification.title}
                    text={plugin.lastNotification.body}
                  />
                )}
              </div>
            )
          })}
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
          tone="accent"
          title={`${plugins.find((p) => p.id === prompt.pluginId)?.manifest?.name ?? prompt.pluginId} asks for ${prompt.title}`}
          text={prompt.description}
        >
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault()
              const value = secret
              setSecret('')
              void run(() => window.electronAPI.pluginsSecretReply(prompt.id, value))
            }}
          >
            <input
              className="input-compact font-mono"
              type="password"
              autoComplete="off"
              aria-label={prompt.title}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <div className="settings-callout-actions">
              <button
                className="btn-secondary"
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
            </div>
          </form>
        </SettingsCallout>
      ))}
    </SettingsPage>
  )
}
