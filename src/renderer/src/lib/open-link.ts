import { openPullRequestFromLink } from '../../../../plugins/github/src/open'

/** A modifier on the click asks for the browser whatever the link is: the
 *  same convention as a terminal's Cmd-click, and the way back to GitHub's
 *  own page for anything the panel does not show. */
export const wantsExternal = (event: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): boolean => event.metaKey || event.ctrlKey || event.shiftKey

/** Open a link the way the app wants it opened: a GitHub pull request in the
 *  side panel when the bundled GitHub plugin is running, everything else in
 *  the default browser through main's `openExternal` (which is also where a
 *  disallowed scheme is refused). Callers hand it every link they render, so
 *  the decision lives in one place rather than in each markdown renderer. */
export function openLink(href: string, options: { external?: boolean } = {}): Promise<void> {
  if (!options.external && openPullRequestFromLink(href)) return Promise.resolve()
  return window.electronAPI.openExternal(href)
}
