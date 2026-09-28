import { Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { focusedOrPrimaryWindow, bringForward } from './window-routing'
import { windowRegistry } from './window-registry'
import { workspaceManager } from './workspace-manager'
import { checkForUpdatesNow, openUpdaterLog, RELEASES_URL } from './auto-updater'
import { getStoredKeymapConfig } from './ipc-handlers/keymap-handlers'
import { isMouseChord, type KeymapActionId } from '../shared/keymaps'

const REPO_URL = 'https://github.com/antasphere/clave'
// electron-builder's productName, stated rather than read: `app.name` is the
// package name ("clave") until the app is packaged, so the menu would say
// "Quit clave" in dev and "Quit Clave" in a release.
const APP_NAME = 'Clave'

/** Bring the window forward and put the user on a Settings pane. */
function openSettingsSection(section: string): void {
  const win = focusedOrPrimaryWindow()
  if (!win) return
  bringForward(win)
  win.webContents.send('menu:open-settings-section', section)
}

/**
 * "Check for Updates…" — the menu bar item every Mac app has and Clave did
 * not.
 *
 * It does two things on purpose: it runs the check, and it takes the user to
 * the Software Update pane so the *result* has somewhere to appear. A check
 * whose answer lands nowhere is what left a user with a new release published,
 * an app that knew about it, and no surface saying so.
 */
async function checkForUpdatesFromMenu(): Promise<void> {
  openSettingsSection('updates')
  await checkForUpdatesNow()
}

/**
 * Clave ran on Electron's default menu, which has no Check for Updates and no
 * Help entries. Replacing it means we now own every standard item too — the
 * Edit roles below are not decoration, they are what keeps ⌘C/⌘V working.
 */
export interface AppMenuDeps {
  /** Open a new window on a workspace (index.ts owns createWindow). */
  openWindow: (workspaceId: string | null) => { windowId: number }
}

export function buildAppMenu(deps: AppMenuDeps): void {
  const keymaps = getStoredKeymapConfig()
  const acceleratorFor = (actionId: KeymapActionId): string | undefined => {
    // A mouse binding has no accelerator form: Electron would reject the menu.
    const binding = keymaps.bindings[actionId].find(
      (candidate) => !candidate.includes(' ') && candidate !== 'Master' && !isMouseChord(candidate)
    )
    if (!binding) return undefined
    return binding
      .split('+')
      .map((token) => {
        if (token === 'Mod') return 'Command'
        if (token === 'Ctrl') return 'Control'
        if (token === 'Alt') return 'Alt'
        return token
      })
      .join('+')
  }
  // File › New Window: the app once more, on the workspace of the window
  // the user is looking at (else the last-active one). ⌘⇧N is free: ⌘N is
  // the renderer's new-session shortcut.
  const newWindow = (): void => {
    const current = focusedOrPrimaryWindow()
    const workspaceId =
      (current ? windowRegistry.getWorkspaceForWindow(current.id) : null) ??
      workspaceManager.resolveInitialWorkspaceId()
    deps.openWindow(workspaceId)
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            void checkForUpdatesFromMenu()
          }
        },
        {
          label: 'Download Latest Version…',
          click: () => {
            void shell.openExternal(RELEASES_URL)
          }
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: acceleratorFor('openSettings'),
          // Displayed but not registered: the renderer already owns ⌘, and
          // should keep owning it, so the two cannot fight.
          registerAccelerator: false,
          click: () => openSettingsSection('general')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: acceleratorFor('newWindow'),
          registerAccelerator: false,
          click: newWindow
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        // ⌘W closes a file tab when one is focused and falls through to the
        // window otherwise — the behaviour the default menu already gave us.
        {
          role: 'close',
          accelerator: acceleratorFor('closeFocused'),
          registerAccelerator: false
        },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Clave on GitHub',
          click: () => {
            void shell.openExternal(REPO_URL)
          }
        },
        {
          label: 'Release Notes',
          click: () => {
            void shell.openExternal(RELEASES_URL)
          }
        },
        { type: 'separator' },
        {
          label: 'Open Updater Log',
          click: () => {
            void openUpdaterLog()
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
