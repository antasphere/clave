import { parsePullRequestUrl, type PullRef } from '../../../src/shared/github-pull'
import {
  pluginPanels,
  usePluginUIStore
} from '../../../src/renderer/src/components/plugins/plugin-ui-store'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'
import { useGithubPanelStore } from './store'

export const GITHUB_PLUGIN_ID = 'clave.github'
export const PULL_PANEL_ID = 'pull-request'

/** Whether the panel can be shown: the plugin is enabled, running, and has
 *  claimed its side-panel contribution. Read off the plugin UI store's copy
 *  of the records, so a click can decide synchronously. */
export function pullPanelAvailable(): boolean {
  return pluginPanels(usePluginUIStore.getState().records, 'side').some(
    (panel) => panel.pluginId === GITHUB_PLUGIN_ID && panel.panelId === PULL_PANEL_ID
  )
}

/** Show a pull request in the side panel: select it in the plugin's store,
 *  bring the panel's tab forward, and open the side panel if it is closed. */
export function openPullRequest(ref: PullRef): void {
  useGithubPanelStore.getState().open(ref)
  usePluginUIStore.getState().openSidePanel({ pluginId: GITHUB_PLUGIN_ID, panelId: PULL_PANEL_ID })
  const session = useSessionStore.getState()
  if (!session.fileTreeOpen) session.toggleFileTree()
}

/** A clicked link: opened in the panel when it names a pull request on
 *  github.com and the panel is available, else left to the caller (the
 *  browser). Returns whether the panel took it. */
export function openPullRequestFromLink(href: string): boolean {
  const ref = parsePullRequestUrl(href)
  if (!ref || !pullPanelAvailable()) return false
  openPullRequest(ref)
  return true
}
