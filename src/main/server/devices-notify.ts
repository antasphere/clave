/**
 * A phone asks to pair and no window is focused: a macOS notification says
 * so, the way the secret request manager says a secret is requested, and a
 * click opens Settings → Mobile in the front window. The ask reaches main
 * as the server event `devices.pairing_requested`, relayed by every window
 * over IPC (the server may run apart from the app, so main cannot hear it
 * itself); main acts on each event once, by its id. Nothing of the phone
 * but its name and platform; never a token. Under `--test-no-activate` no
 * window is ever focused and nothing may reach the person's desktop, so the
 * ask is counted on the test hooks namespace instead and the specs read it.
 */
import { app, BrowserWindow, Notification, ipcMain } from 'electron'
import type { DevicePlatform } from '@clave/contract/devices'
import { bringForward, focusedOrPrimaryWindow } from '../window-routing'
import { TEST_NO_ACTIVATE } from '../test-mode'

const PLATFORM_LABEL: Record<DevicePlatform, string> = { ios: 'iPhone', android: 'Android' }

export interface PairingNotice {
  readonly pairingId: string
  readonly name: string
  readonly platform: DevicePlatform
}

/** What a notification would have said, under the test flag. */
const notices = (): PairingNotice[] => {
  const hooks = globalThis as { __claveE2E?: { devicesNotified?: PairingNotice[] } }
  return ((hooks.__claveE2E ??= {}).devicesNotified ??= [])
}

export function notifyPairingRequested(pairing: PairingNotice): void {
  if (TEST_NO_ACTIVATE) {
    notices().push({ pairingId: pairing.pairingId, name: pairing.name, platform: pairing.platform })
    return
  }
  if (!Notification.isSupported() || BrowserWindow.getFocusedWindow()) return
  const notification = new Notification({
    title: 'Clave — a phone asks to pair',
    body: `${pairing.name} (${PLATFORM_LABEL[pairing.platform]}) is waiting for your approval in Settings → Mobile.`,
    silent: false
  })
  notification.on('click', () => {
    const win = focusedOrPrimaryWindow()
    bringForward(win)
    win?.webContents.send('menu:open-settings-section', 'mobile')
  })
  notification.show()
  if (process.platform === 'darwin') app.dock?.bounce('informational')
}

const isPlatform = (value: unknown): value is DevicePlatform =>
  value === 'ios' || value === 'android'

/** The relay's arm in main: one notice per event id, from a Clave window only. */
export function registerDevicesNotificationHandlers(): void {
  const relayed = new Set<string>()
  ipcMain.handle(
    'devices:pairing-requested',
    (event, id: unknown, pairingId: unknown, name: unknown, platform: unknown) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        return
      if (typeof id !== 'string' || relayed.has(id)) return
      relayed.add(id)
      if (relayed.size > 200) relayed.delete(relayed.values().next().value as string)
      if (typeof pairingId !== 'string' || typeof name !== 'string' || !isPlatform(platform)) return
      notifyPairingRequested({ pairingId, name: name.slice(0, 120), platform })
    }
  )
}
