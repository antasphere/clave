import type { WebContents } from 'electron'
import { RuntimePluginViews } from './views'
import { attachPluginFramePolicy } from './protocol'

let host: RuntimePluginViews | undefined
export function setRuntimePluginViewHost(value: RuntimePluginViews): void {
  host = value
}
export function revokePluginSessionViews(sessionId: string): void {
  host?.revokeSession(sessionId)
}
export function attachRuntimePluginHost(contents: WebContents): void {
  const owner = contents.id
  attachPluginFramePolicy(contents)
  contents.once('destroyed', () => host?.revokeOwner(owner))
  contents.on('render-process-gone', () => host?.revokeOwner(owner))
  contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) host?.revokeOwner(owner)
  })
}
