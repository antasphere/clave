import { app, session, shell, type BrowserWindow, type WebContents } from 'electron'
import { decideNavigation } from '../shared/view-navigation'
import { allowsViewPermission } from '../shared/view-permissions'

/**
 * The web views behind a group's or a session's attached page.
 *
 * A view is an Electron `<webview>`: a guest page with a history of its own,
 * which is what gives the pane its back, forward and home. The guest is also a
 * page nobody vetted, running inside the app's window, so three things are
 * pinned here and nowhere else:
 *
 *  - The guest never gets the app's powers. `will-attach-webview` strips any
 *    preload, keeps node integration off and context isolation on, and only
 *    lets a page attach at all when it is http(s) or served from disk by the
 *    app's own `clave-preview` protocol (an .html file and its folder, nothing
 *    beyond).
 *  - The guest never gets the machine's either. Every guest lives in the
 *    `VIEW_PARTITION` session, whose permission handlers refuse camera,
 *    notifications, location, clipboard and the rest. Electron grants by
 *    default; a dashboard has no business asking. The ONE exception is the
 *    microphone for a page Clave serves from this machine — an Exos board, a
 *    dev server, the Exos voice dock — which is the pages the person started
 *    themselves. The rule is `shared/view-permissions.ts`, kept pure and
 *    tested because a rule too loose fails silently: a page nobody vetted
 *    gets a microphone and nothing in the app looks any different.
 *  - Where a link goes is decided by `decideNavigation` (shared, unit-tested):
 *    the local machine and the view's own origin stay in the pane, the rest of
 *    the web opens in the system browser, anything else is dropped. The rule
 *    runs on `will-navigate` AND on every `will-redirect` hop — a 302 is a
 *    navigation like any other, and the one a page cannot be trusted with.
 *    Home is the first entry of the guest's history, the `src` the pane
 *    mounted with. Popups follow the app window's own rule: the system
 *    browser, never a new Electron window.
 *
 * The partition is persistent and shared by every view: cookies and storage
 * behave as in one browser profile, so a dashboard's sign-in survives a
 * restart. What is never persisted is the trail (the history), which is the
 * reader's and dies with the pane.
 */
const HTTP = /^https?:\/\//i
/** What may load as a guest at all: the web, or a file page the app serves. */
const ATTACHABLE = /^(?:https?|clave-preview):\/\//i

/** The one session every view guest runs in — `WebViewPane` mounts the tag on it. */
export const VIEW_PARTITION = 'persist:view'

export function hardenViewHost(win: BrowserWindow): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    if (!ATTACHABLE.test(params.src ?? '')) event.preventDefault()
  })
}

/** Apply the link rule to one navigation of a guest; false = it was stopped. */
function policeNavigation(contents: WebContents, url: string): boolean {
  const home = contents.navigationHistory.getEntryAtIndex(0)?.url || contents.getURL()
  const decision = decideNavigation(home, url)
  if (decision === 'in-pane') return true
  if (decision === 'external') shell.openExternal(url).catch(() => {})
  return false
}

export function installViewGuestPolicy(): void {
  const viewSession = session.fromPartition(VIEW_PARTITION)

  // The microphone, and only for a page Clave serves from this machine. See
  // `shared/view-permissions.ts` for the rule; the two handlers ask the SAME
  // function because a page granted by one and refused by the other gets a
  // stream it is then told it does not have.
  //
  // The origin is taken from the details Chromium passes, never from the
  // contents' current URL: a page can navigate between the check and the
  // request, and the URL read late is not the URL that asked.
  viewSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const origin = 'securityOrigin' in details ? details.securityOrigin : undefined
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(allowsViewPermission(origin ?? '', permission, mediaTypes))
  })
  viewSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const mediaType = details.mediaType
    return allowsViewPermission(requestingOrigin, permission, mediaType ? [mediaType] : undefined)
  })

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    // A popup ALWAYS leaves, local or not, by design: a page that asks for a
    // new window wants the reader to keep this one (a demo guide opening the
    // app it walks through), and the pane has no second window to give it.
    // A plain link is the in-pane path; that is where the trail rule applies.
    contents.setWindowOpenHandler(({ url }) => {
      if (HTTP.test(url)) shell.openExternal(url).catch(() => {})
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      if (!policeNavigation(contents, url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!policeNavigation(contents, url)) event.preventDefault()
    })
  })
}
