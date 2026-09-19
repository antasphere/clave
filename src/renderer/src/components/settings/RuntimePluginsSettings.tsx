import { useEffect, useState } from 'react'
import type { InstalledRuntimePlugin } from '../../../../shared/runtime-plugins'
import {
  SettingsCard,
  SettingsCallout,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from './primitives'

export function RuntimePluginsSettings(): React.JSX.Element {
  const [plugins, setPlugins] = useState<InstalledRuntimePlugin[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = (): void => {
    void window.electronAPI.runtimePlugins
      .list()
      .then(setPlugins)
      .catch((e) => setError(String(e)))
  }
  useEffect(() => {
    refresh()
    return window.electronAPI.runtimePlugins.onChanged(refresh)
  }, [])
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsPage
      title="Runtime plugins"
      description="Local providers and isolated conversation views."
      actions={
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => void run(() => window.electronAPI.runtimePlugins.install())}
        >
          Install local folder
        </button>
      }
    >
      <SettingsCallout
        title="Only install code you trust"
        text="Provider plugins run native code with your account's privileges. Generated HTML has no capabilities; installed enhancers receive only the capabilities listed below."
      />
      {error && (
        <div role="alert">
          <SettingsCallout tone="danger" text={error} />
        </div>
      )}
      <SettingsSection
        title="Installed plugins"
        description="New sessions use updated providers. Views keep the revision first used in their conversation. Disabling a local plugin removes its views without stopping running provider sessions."
      >
        <SettingsCard>
          {plugins.map((plugin) => (
            <SettingsRow
              key={plugin.manifest.id}
              label={`${plugin.manifest.name} · ${plugin.manifest.version}`}
              description={
                <>
                  {plugin.builtin
                    ? 'Ships with Clave'
                    : plugin.manifest.provider
                      ? 'Trusted native provider code'
                      : 'Isolated UI views'}{' '}
                  · {plugin.enabled ? 'Enabled' : 'Disabled'}
                  <span className="block">
                    Revision: <code title={plugin.revision}>{plugin.revision.slice(0, 12)}</code>
                  </span>
                  {plugin.manifest.views.map((view) => (
                    <span className="block" key={view.id}>
                      {view.name}: {view.capabilities.join(', ') || 'No capabilities'}
                    </span>
                  ))}
                </>
              }
            >
              {!plugin.builtin && (
                <>
                  <button
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(() => window.electronAPI.runtimePlugins.update(plugin.manifest.id))
                    }
                  >
                    Update from folder
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        window.electronAPI.runtimePlugins.setEnabled(
                          plugin.manifest.id,
                          !plugin.enabled
                        )
                      )
                    }
                  >
                    {plugin.enabled ? 'Disable' : 'Enable'}
                  </button>
                </>
              )}
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  )
}
