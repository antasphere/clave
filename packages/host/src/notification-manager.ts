import { ipcMain, Notification, BrowserWindow, app } from 'electron'
import { bringForward } from './window-routing'

export type NotificationStatus = 'shown' | 'skipped-focused' | 'unsupported'

export function initNotificationManager(): void {
  ipcMain.handle(
    'notification:show',
    (event, options: { title: string; body: string; sessionId: string }): NotificationStatus => {
      if (!Notification.isSupported()) {
        console.log('[notification] Notifications not supported on this system')
        return 'unsupported'
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      if (win?.isFocused()) {
        console.log('[notification] Skipped (window is focused):', options.body)
        return 'skipped-focused'
      }

      console.log('[notification] Showing:', options.title, '-', options.body)

      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: false
      })

      notification.on('click', () => {
        bringForward(win)
        event.sender.send('notification:clicked', options.sessionId)
      })

      notification.show()
      if (process.platform === 'darwin') {
        app.dock?.bounce('informational')
      }
      return 'shown'
    }
  )
}
