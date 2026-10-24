/**
 * The plugin service of the Electron shell (PRDCT-3433): the one instance
 * main builds when its server runs in-process, handed to the server as
 * `ports.plugins` and to the IPC arms of `ipc-handlers/plugin-ipc.ts`. Built
 * on first use and once: an app attached to a server elsewhere never builds
 * it, since the plugins run beside that server's sessions, not here.
 *
 * What is Electron's stays here: the plugin processes on `utilityProcess`
 * (`electron-runner.ts`), the OS notification a plugin raises, the fan-out of
 * `plugins:changed` to the windows over IPC (the preload hears it on one
 * transport, IPC until the push channel is welcomed), and the stop at quit.
 */
import { app, BrowserWindow, Notification } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OWN_PROFILE, TEST_NO_ACTIVATE } from '../test-mode'
import { installE2eHooks } from '../sessions/e2e-hooks'
import { electronRunner } from './electron-runner'
import { createPluginService, refusingPluginService, type PluginService } from './plugin-service'

let service: PluginService | null = null

export function shellPlugins(): PluginService {
  if (service) return service
  const root =
    TEST_NO_ACTIVATE || OWN_PROFILE
      ? join(app.getPath('userData'), 'clave-plugins')
      : join(homedir(), '.clave')
  const bundled = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'plugins')
  try {
    service = createPluginService({
      root,
      bundled,
      version: app.getVersion(),
      spawner: electronRunner(),
      notify: ({ name, title, body }) => {
        if (!TEST_NO_ACTIVATE && Notification.isSupported())
          new Notification({ title: `${name}: ${title}`, body: body ?? '' }).show()
      }
    })
  } catch (error) {
    const message = `Plugin registry could not be read: ${String(error)}`
    console.error(message)
    service = refusingPluginService(message)
  }
  installE2eHooks({ plugins: service })
  service.subscribe((event) => {
    if (event._tag !== 'plugins.changed') return
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send('plugins:changed')
  })
  app.once('before-quit', () => service?.close())
  return service
}

/** Tests only. */
export function resetShellPluginsForTests(): void {
  service = null
}
