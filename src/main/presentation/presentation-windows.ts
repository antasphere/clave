/**
 * Presentation windows (PRDCT-4980): a session's deck alone, full screen, in
 * a window of its own. An app window that lists the session holds the
 * preview (its own hold, the way its panel does) and hands main the address
 * it got: this Mac's loopback for a session of this Mac, the port this Mac
 * forwards a server's preview on otherwise. Main only shows it.
 *
 * One presentation per session: every app window that lists a server's
 * session hears an agent's ask, and the first to show it presents it; the
 * others are answered `false` and let go of their holds. A presentation has
 * an id its window keeps across what moves it (a new preview, a new open);
 * once the person closes it, a late show of that id is refused rather than
 * opening it again.
 *
 * A presentation window is never an app window: it is not in the window
 * registry, not in `windows.json`, adopts no tab, is not restored at boot,
 * and it closes with the app window that presents it (closed or reloaded:
 * its hold dies with its page). Escape closes it, whichever frame has the
 * focus (`before-input-event` sees the keys of every frame of the page).
 *
 * The page is an agent's: no preload, no Node, a sandboxed renderer on a
 * session of its own (in memory, nothing written to disk) whose permissions
 * are full screen and copy alone. That session is one the forward gate
 * stamps (`src/main/index.ts`), or a server's preview would be refused.
 */
import { BrowserWindow, ipcMain, screen, session, shell, type WebContents } from 'electron'
import { installE2eHooks } from '../sessions/e2e-hooks'
import { TEST_NO_ACTIVATE } from '../test-mode'
import {
  endsPresentation,
  opensInBrowser,
  pickDisplay,
  presentableUrl,
  presentationPermits,
  staysOnPreview
} from './presentation-rules'

/** The presentation windows' session: in memory, its own permissions. */
export const PRESENTATION_PARTITION = 'clave-presentation'

interface Presentation {
  readonly win: BrowserWindow
  readonly owner: WebContents
  readonly sessionId: string
  presentationId: string
  url: string
  readonly displayId: number | null
  /** Put on screen once (its first paint): from then on a show brings it forward. */
  onScreen: boolean
  /** Asked to close: a show from now on opens a window of its own rather than
   *  taking this one, whose close would then mark the new presentation closed. */
  closing: boolean
}

/** Close a presentation's window, marked closing at once (the close itself is asynchronous). */
const closeIt = (presentation: Presentation): void => {
  presentation.closing = true
  if (!presentation.win.isDestroyed()) presentation.win.close()
}

/** By session: one presentation each, whichever window presents it. */
const presentations = new Map<string, Presentation>()
/** The presentations the person closed, newest last: a late show of one is refused. */
const closedIds = new Set<string>()
const CLOSED_KEPT = 500

/** Under test mode, what main answered each show, oldest first (who asked, taken or not). */
const answers: { sessionId: string; ownerWebContentsId: number; taken: boolean }[] = []

/** Under test mode nothing reaches the person's browser: the links are kept here. */
const linksOpened: string[] = []
const openOutside = (url: string): void => {
  if (TEST_NO_ACTIVATE) linksOpened.push(url)
  else void shell.openExternal(url).catch(() => {})
}

let policyInstalled = false
function presentationSession(): Electron.Session {
  const own = session.fromPartition(PRESENTATION_PARTITION)
  if (!policyInstalled) {
    policyInstalled = true
    own.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(presentationPermits(permission))
    )
    own.setPermissionCheckHandler((_contents, permission) => presentationPermits(permission))
  }
  return own
}

const ownersWatched = new Set<number>()
/** The app window's page ends: the presentations it presents end with it. */
function watchOwner(owner: WebContents): void {
  if (ownersWatched.has(owner.id)) return
  const id = owner.id
  ownersWatched.add(id)
  const endAll = (): void => {
    for (const p of [...presentations.values()]) if (p.owner.id === id) closeIt(p)
  }
  owner.once('destroyed', () => {
    ownersWatched.delete(id)
    endAll()
  })
  // A reload: the window's holds died with its page, so would the deck.
  owner.on('did-navigate', endAll)
}

function open(
  owner: WebContents,
  sessionId: string,
  url: string,
  title: string,
  presentationId: string
): void {
  const ownerWindow = BrowserWindow.fromWebContents(owner)
  const ownerDisplay =
    ownerWindow && !ownerWindow.isDestroyed()
      ? screen.getDisplayMatching(ownerWindow.getBounds())
      : null
  const display = pickDisplay(screen.getAllDisplays(), ownerDisplay?.id ?? null)
  const area = display?.bounds
  const win = new BrowserWindow({
    ...(area
      ? { x: area.x, y: area.y, width: area.width, height: area.height }
      : { width: 1280, height: 800 }),
    show: false,
    title,
    backgroundColor: '#000000',
    fullscreenable: true,
    webPreferences: {
      session: presentationSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // A test instance never shows a window: its timers keep running all the same.
      ...(TEST_NO_ACTIVATE ? { backgroundThrottling: false } : {})
    }
  })
  const presentation: Presentation = {
    win,
    owner,
    sessionId,
    presentationId,
    url,
    displayId: display?.id ?? null,
    onScreen: false,
    closing: false
  }
  presentations.set(sessionId, presentation)

  // The deck's own title would replace the artefact's.
  win.on('page-title-updated', (event) => event.preventDefault())
  win.webContents.on('before-input-event', (event, input) => {
    if (!endsPresentation(input)) return
    event.preventDefault()
    closeIt(presentation)
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (staysOnPreview(target, presentation.url)) return
    event.preventDefault()
    if (opensInBrowser(target)) openOutside(target)
  })
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (opensInBrowser(target)) openOutside(target)
    return { action: 'deny' }
  })
  win.once('ready-to-show', () => {
    // Under --test-no-activate no window is ever put on screen (test-mode.ts).
    if (TEST_NO_ACTIVATE || win.isDestroyed()) return
    presentation.onScreen = true
    win.show()
    win.setFullScreen(true)
  })
  // Closed by hand (the window's button, the keyboard): closing from the first moment.
  win.on('close', () => {
    presentation.closing = true
  })
  win.on('closed', () => {
    if (presentations.get(sessionId) === presentation) presentations.delete(sessionId)
    closedIds.add(presentation.presentationId)
    if (closedIds.size > CLOSED_KEPT) closedIds.delete(closedIds.values().next().value!)
    if (!owner.isDestroyed())
      owner.send('presentation:closed', {
        sessionId,
        presentationId: presentation.presentationId
      })
  })
  watchOwner(owner)
  void win.loadURL(url).catch(() => {})
}

/**
 * Show the session's deck at `url`, or move its presentation there and bring
 * it forward. False when `owner` is not the window presenting it: another
 * window does, or the person closed this presentation.
 */
export function showPresentation(
  owner: WebContents,
  sessionId: string,
  url: string,
  title: string,
  presentationId: string
): boolean {
  if (closedIds.has(presentationId)) return false
  const existing = presentations.get(sessionId)
  if (!existing || existing.win.isDestroyed() || existing.closing) {
    open(owner, sessionId, url, title, presentationId)
    return true
  }
  const forward = (): void => {
    // Before its first paint, ready-to-show puts it on screen, full screen.
    if (TEST_NO_ACTIVATE || !existing.onScreen) return
    existing.win.show()
    existing.win.focus()
  }
  if (existing.owner.id !== owner.id) {
    forward()
    return false
  }
  existing.presentationId = presentationId
  existing.win.setTitle(title)
  if (existing.url !== url) {
    existing.url = url
    void existing.win.loadURL(url).catch(() => {})
  }
  forward()
  return true
}

/** Close the session's presentation, when `owner` is the window presenting it. */
export function closePresentation(owner: WebContents, sessionId: string): void {
  const existing = presentations.get(sessionId)
  if (existing && existing.owner.id === owner.id && !existing.closing) closeIt(existing)
}

const ID_MAX = 512
const TITLE_MAX = 200
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= ID_MAX

export function registerPresentationHandlers(): void {
  ipcMain.handle(
    'presentation:show',
    (event, sessionId: unknown, url: unknown, title: unknown, presentationId: unknown): boolean => {
      if (!isId(sessionId) || !isId(presentationId)) throw new Error('No session to present.')
      const page = presentableUrl(url)
      if (!page) throw new Error("Only a preview running on this Mac's loopback can be presented.")
      const name =
        typeof title === 'string' && title.trim() !== ''
          ? title.slice(0, TITLE_MAX)
          : 'Presentation'
      const taken = showPresentation(event.sender, sessionId, page, name, presentationId)
      if (TEST_NO_ACTIVATE) answers.push({ sessionId, ownerWebContentsId: event.sender.id, taken })
      return taken
    }
  )
  ipcMain.handle('presentation:close', (event, sessionId: unknown): void => {
    if (isId(sessionId)) closePresentation(event.sender, sessionId)
  })
  installE2eHooks({
    presentations: {
      list: () =>
        [...presentations.values()]
          .filter((p) => !p.win.isDestroyed())
          .map((p) => ({
            sessionId: p.sessionId,
            presentationId: p.presentationId,
            url: p.url,
            title: p.win.getTitle(),
            windowId: p.win.id,
            ownerWebContentsId: p.owner.id,
            displayId: p.displayId
          })),
      linksOpened: () => [...linksOpened],
      answers: () => [...answers]
    }
  })
}
