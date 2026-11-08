import { useEffect, useState } from 'react'
import type { PluginActionPreviewRow, PluginActionTarget } from '@clave/plugin-sdk'
import type { PluginActionEntry } from './plugin-actions-model'

/** The card beside a highlighted action: the rows the plugin previews for the target, a
 *  label and a value each. The box is drawn empty while they load so the card does not
 *  jump, and nothing at all when the plugin cannot answer. */
export function PluginActionPreview({
  entry,
  target
}: {
  entry: PluginActionEntry
  target: PluginActionTarget
}): React.JSX.Element | null {
  const [rows, setRows] = useState<PluginActionPreviewRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const { pluginId, id } = entry
  useEffect(() => {
    let mounted = true
    setRows(null)
    setFailed(false)
    window.electronAPI
      .pluginsPreviewAction(pluginId, id, target)
      .then((next) => {
        if (mounted) setRows(next)
      })
      .catch(() => {
        if (mounted) setFailed(true)
      })
    return () => {
      mounted = false
    }
    // The target is rebuilt on every menu render; only its id changes what is asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, id, target.id])
  if (failed) return null
  return (
    <div className="min-w-[168px] px-2 py-1.5" data-plugin-action-preview={entry.id}>
      {(rows ?? []).map((row, index) => (
        <div
          key={`${index}:${row.label}`}
          className="flex items-center justify-between gap-4 h-control-xs"
        >
          <span className="text-[11px] text-text-tertiary">{row.label}</span>
          <span className="text-[12px] text-text-primary tabular-nums text-right">{row.value}</span>
        </div>
      ))}
    </div>
  )
}
