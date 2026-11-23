/**
 * Presentation windows (PRDCT-4980): a session's deck alone, full screen, in
 * a window of its own. The app window holding the session holds the preview
 * (its own hold, the way its panel does) and hands main the address it got:
 * this Mac's loopback for a session of this Mac, the port this Mac forwards a
 * server's preview on otherwise. Main only shows it.
 *
 * A presentation window is never an app window: it is not in the window
 * registry, not in `windows.json`, adopts no tab, is not restored at boot,
 * and it closes with the app window that asked for it (closed or reloaded:
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
  url: string
  readonly displayId: number | null
}

const presentations = new Map<string, Presentation>()
const keyOf = (ownerId: number, sessionId: string): string => `${ownerId}\n${sessionId}`

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
/** The app window's page ends: its presentations end with it. */
function watchOwner(owner: WebContents): void {
  if (ownersWatched.has(owner.id)) return
  const id = owner.id
  ownersWatched.add(id)
  const endAll = (): void => {
    for (const p of [...presentations.values()]) if (p.owner.id === id) p.win.close()
  }
  owner.once('destroyed', () => {
    ownersWatched.delete(id)
    endAll()
  })
  // A reload: the window's holds died with its page, so would the deck.
  owner.on('did-navigate', endAll)
}

function open(owner: WebContents, sessionId: string, url: string, title: string): Presentation {
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
    url,
    displayId: display?.id ?? null
  }
  const key = keyOf(owner.id, sessionId)
  presentations.set(key, presentation)

  // The deck's own title would replace the artefact's.
  win.on('page-title-updated', (event) => event.preventDefault())
  win.webContents.on('before-input-event', (event, input) => {
    if (!endsPresentation(input)) return
    event.preventDefault()
    win.close()
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (staysOnPreview(target, presentation.url)) return
    event.preventDefault()
    if (opensInBrowser(target)) void shell.openExternal(target).catch(() => {})
  })
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (opensInBrowser(target)) void shell.openExternal(target).catch(() => {})
    return { action: 'deny' }
  })
  win.once('ready-to-show', () => {
    // Under --test-no-activate no window is ever put on screen (test-mode.ts).
    if (TEST_NO_ACTIVATE || win.isDestroyed()) return
    win.show()
    win.setFullScreen(true)
  })
  win.on('closed', () => {
    if (presentations.get(key) === presentation) presentations.delete(key)
    if (!owner.isDestroyed()) owner.send('presentation:closed', sessionId)
  })
  watchOwner(owner)
  void win.loadURL(url).catch(() => {})
  return presentation
}

/** Show the session's deck at `url`, or move its open presentation there and bring it forward. */
export function showPresentation(
  owner: WebContents,
  sessionId: string,
  url: string,
  title: string
): void {
  const existing = presentations.get(keyOf(owner.id, sessionId))
  if (!existing || existing.win.isDestroyed()) {
    open(owner, sessionId, url, title)
    return
  }
  if (existing.url !== url) {
    existing.url = url
    void existing.win.loadURL(url).catch(() => {})
  }
  if (!TEST_NO_ACTIVATE) {
    existing.win.show()
    existing.win.focus()
  }
}

export function closePresentation(owner: WebContents, sessionId: string): void {
  const existing = presentations.get(keyOf(owner.id, sessionId))
  if (existing && !existing.win.isDestroyed()) existing.win.close()
}

const SESSION_ID_MAX = 512
const TITLE_MAX = 200

export function registerPresentationHandlers(): void {
  ipcMain.handle(
    'presentation:show',
    (event, sessionId: unknown, url: unknown, title: unknown): void => {
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > SESSION_ID_MAX)
        throw new Error('No session to present.')
      const page = presentableUrl(url)
      if (!page) throw new Error("Only a preview running on this Mac's loopback can be presented.")
      const name =
        typeof title === 'string' && title.trim() !== ''
          ? title.slice(0, TITLE_MAX)
          : 'Presentation'
      showPresentation(event.sender, sessionId, page, name)
    }
  )
  ipcMain.handle('presentation:close', (event, sessionId: unknown): void => {
    if (typeof sessionId === 'string') closePresentation(event.sender, sessionId)
  })
  installE2eHooks({
    presentations: {
      list: () =>
        [...presentations.values()]
          .filter((p) => !p.win.isDestroyed())
          .map((p) => ({
            sessionId: p.sessionId,
            url: p.url,
            windowId: p.win.id,
            ownerWebContentsId: p.owner.id,
            displayId: p.displayId,
            partition: PRESENTATION_PARTITION
          }))
    }
  })
}
