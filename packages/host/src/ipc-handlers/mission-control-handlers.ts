import { app, ipcMain } from 'electron'
import {
  isMissionControlEnabled,
  setMissionControlEnabled,
  simulateMissionControl
} from '../mission-control-manager'

export function registerMissionControlHandlers(): void {
  ipcMain.handle('mission-control:get-enabled', () => isMissionControlEnabled())
  ipcMain.handle('mission-control:set-enabled', (_event, enabled: boolean) =>
    setMissionControlEnabled(enabled === true)
  )
  if (!app.isPackaged) {
    ipcMain.handle('mission-control:simulate', (_event, entered: boolean) =>
      simulateMissionControl(entered === true)
    )
  }
}
