import type { ComponentType } from 'react'
import { PullRequestPanel } from '../../../../../plugins/github/src/PullRequestPanel'

/** Bundled native panels, keyed like native views: `<pluginId>/<panelId>`. A
 *  plugin here is one the app ships and compiles into the renderer; a linked
 *  plugin contributes surfaces only, for the same reason `registry.tsx` gives
 *  for views. The manifest still declares the panel and the plugin process
 *  still registers it, so enabling, disabling and the tab that appears in the
 *  side panel are the ordinary plugin host's — only the rendering is native. */
export const nativePanels: Record<string, ComponentType> = {
  'clave.github/pull-request': PullRequestPanel
}
