import { preferencesManager } from '../preferences-manager'

/** `<pluginId>/<viewId>`, both halves non-empty: the shape `setView` accepts. */
const VIEW_ID = /^[^/\s]+\/[^/\s]+$/
const pluginOf = (viewId: string): string => viewId.split('/')[0]

/**
 * The view a new chat opens in: the last one the reader picked in a pane's
 * view picker (Chat, Compact, Terminal…), so a reader who settled on one is
 * not sent back to the profile's default on every new tab. Clearing a
 * session's view (a null pick) forgets nothing: that is the host resetting a
 * pane, not the reader choosing.
 */
export function rememberChatView(viewId: string | null): void {
  if (viewId === null || !VIEW_ID.test(viewId)) return
  preferencesManager.set('chatView', viewId)
}

/**
 * The view a session launched on a profile opens in. The remembered pick wins
 * over the profile's own default only when both come from the same plugin: a
 * profile that names another plugin's view (a plugin adapter's own page) keeps
 * it. A profile that names none takes the pick; if the session cannot render
 * it, resolution in the renderer falls back as it does for any stale choice.
 */
export function initialChatView(profileDefault: string | undefined): string | undefined {
  const remembered = preferencesManager.get('chatView')
  // The file is the user's to edit: a value of the wrong shape is ignored.
  if (typeof remembered !== 'string' || !VIEW_ID.test(remembered)) return profileDefault
  if (profileDefault && pluginOf(profileDefault) !== pluginOf(remembered)) return profileDefault
  return remembered
}
