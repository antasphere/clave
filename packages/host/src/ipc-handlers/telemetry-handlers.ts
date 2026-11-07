import { ipcMain } from 'electron'
import { getTelemetryState, setTelemetryEnabled, setTelemetryNoticeShown } from '../telemetry'

export function registerTelemetryHandlers(): void {
  ipcMain.handle('telemetry:get-state', () => getTelemetryState())
  ipcMain.handle('telemetry:set-enabled', (_event, enabled: boolean) =>
    setTelemetryEnabled(enabled === true)
  )
  ipcMain.handle('telemetry:set-notice-shown', () => setTelemetryNoticeShown())
}
