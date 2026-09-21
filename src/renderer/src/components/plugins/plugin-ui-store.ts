import { create } from 'zustand'
import { useEffect, useState } from 'react'
import type { PluginRecord } from '../../../../main/plugins/plugin-store'

/** A contribution, resolved against the record that registered it: the manifest says what
 *  it looks like, the record says whether the running plugin actually claimed it. */
export interface PluginPanelEntry {
  pluginId: string
  pluginName: string
  panelId: string
  title: string
  icon: string
  placement: 'side' | 'main'
  /** Bumped when the plugin restarts. A host keys its surface on it, so a restart remounts
   *  the panel on the new run rather than leaving a guest pointed at a revoked URL. */
  generation: number
}
export interface PluginToolbarEntry {
  pluginId: string
  pluginName: string
  id: string
  title: string
  icon: string
  kind: 'action' | 'popover'
  items: { id: string; title: string }[]
}

/** Which plugin surface each host is showing. It lives here rather than in session-store
 *  because a plugin panel is not a session: the side panel's own `sidePanelTab` keeps
 *  meaning Files or Git, and a plugin tab is the choice layered over it. Module state, so
 *  the selection survives the panel being closed and reopened. */
interface PluginUIState {
  sidePanel: { pluginId: string; panelId: string } | null
  mainPanel: { pluginId: string; panelId: string } | null
  openSidePanel: (entry: { pluginId: string; panelId: string } | null) => void
  openMainPanel: (entry: { pluginId: string; panelId: string } | null) => void
}

export const usePluginUIStore = create<PluginUIState>((set) => ({
  sidePanel: null,
  mainPanel: null,
  openSidePanel: (entry) => set({ sidePanel: entry }),
  openMainPanel: (entry) => set({ mainPanel: entry })
}))

let watching = false

/** Watch the registry for the one transition a selection cannot survive: the user switching
 *  a plugin off, or removing it. Resolving the selection against the live records was not
 *  enough — a disabled plugin's panels correctly vanish, but the selection naming them stayed
 *  behind, so switching the plugin back on in Settings reopened both surfaces with no click,
 *  and a main panel reopening takes the whole content column back from the session mosaic.
 *
 *  The test is `enabled`, deliberately, not "the contribution is gone": a plugin that crashes
 *  and restarts clears and re-registers its contributions while staying enabled, and there the
 *  panel the user had open SHOULD come back. Only the user's own switch clears the selection. */
export function initPluginUI(): void {
  if (watching) return
  watching = true
  const prune = (records: PluginRecord[]): void => {
    const dropped = (selection: { pluginId: string } | null): boolean =>
      !!selection && !records.some((record) => record.id === selection.pluginId && record.enabled)
    const state = usePluginUIStore.getState()
    const next: Partial<PluginUIState> = {}
    if (dropped(state.sidePanel)) next.sidePanel = null
    if (dropped(state.mainPanel)) next.mainPanel = null
    if (Object.keys(next).length) usePluginUIStore.setState(next)
  }
  const update = (): void => {
    void window.electronAPI
      .pluginsList()
      .then(prune)
      .catch(() => {
        /* The registry reports its own errors in Settings. */
      })
  }
  update()
  window.electronAPI.onPluginsChanged(update)
}

/** The plugin records, kept current by the host's `plugins:changed` broadcast. Every host
 *  outside the settings page reads its contributions from here. */
export function usePluginRecords(): PluginRecord[] {
  const [records, setRecords] = useState<PluginRecord[]>([])
  useEffect(() => {
    let mounted = true
    const update = (): void => {
      void window.electronAPI
        .pluginsList()
        .then((next) => {
          if (mounted) setRecords(next)
        })
        .catch(() => {
          /* The registry reports its own errors in Settings; a host draws nothing. */
        })
    }
    update()
    const off = window.electronAPI.onPluginsChanged(update)
    return () => {
      mounted = false
      off()
    }
  }, [])
  return records
}

const live = (record: PluginRecord): boolean =>
  record.enabled && record.status === 'active' && !!record.manifest

/** Panels of one placement that are both declared and registered by the running plugin. */
export function pluginPanels(
  records: PluginRecord[],
  placement: 'side' | 'main'
): PluginPanelEntry[] {
  return records.filter(live).flatMap((record) =>
    (record.manifest?.contributes.panels ?? [])
      .filter((panel) => panel.placement === placement && record.panels.includes(panel.id))
      .map((panel) => ({
        pluginId: record.id,
        pluginName: record.manifest?.name ?? record.id,
        panelId: panel.id,
        title: panel.title,
        icon: panel.icon,
        placement,
        generation: record.generation
      }))
  )
}

/** Whether a main-placement plugin panel is currently showing, for the hosts that have to
 *  step aside for it. */
export function usePluginMainPanelOpen(): boolean {
  const selection = usePluginUIStore((s) => s.mainPanel)
  const panels = pluginPanels(usePluginRecords(), 'main')
  return panels.some(
    (entry) => entry.pluginId === selection?.pluginId && entry.panelId === selection?.panelId
  )
}

/** Toolbar entries that are both declared and registered through `ui.registerToolbar`. */
export function pluginToolbarEntries(records: PluginRecord[]): PluginToolbarEntry[] {
  return records.filter(live).flatMap((record) =>
    (record.manifest?.contributes.toolbar ?? [])
      .filter((entry) => record.toolbar.includes(entry.id))
      .map((entry) => ({
        pluginId: record.id,
        pluginName: record.manifest?.name ?? record.id,
        id: entry.id,
        title: entry.title,
        icon: entry.icon,
        kind: entry.kind,
        items: entry.items ?? []
      }))
  )
}
