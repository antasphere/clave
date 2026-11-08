import { ipcMain } from 'electron'
import {
  captureMessage,
  captureSessionState,
  captureTabClosed,
  captureTabSpawn
} from '../exchange-capture/service'
import type {
  MessageCapturePayload,
  SessionStateCapturePayload,
  TabClosedCapturePayload,
  TabSpawnCapturePayload
} from '../exchange-capture/types'

/** Capture IPC: fire-and-forget (`send`, not `invoke`) — capture is
 *  observability and must never delay or fail the delivery it records. The
 *  renderer owns every identity (name, cwd, group, model), so all four kinds
 *  arrive from it with their identities stamped; the main process adds only
 *  what lives on disk (usage snapshots, sidecar discovery). */
export function registerExchangeHandlers(): void {
  ipcMain.on('exchange:capture-message', (_event, payload: MessageCapturePayload) => {
    captureMessage(payload)
  })
  ipcMain.on('exchange:capture-tab-spawn', (_event, payload: TabSpawnCapturePayload) => {
    captureTabSpawn(payload)
  })
  ipcMain.on('exchange:capture-session-state', (_event, payload: SessionStateCapturePayload) => {
    captureSessionState(payload)
  })
  ipcMain.on('exchange:capture-tab-closed', (_event, payload: TabClosedCapturePayload) => {
    captureTabClosed(payload)
  })
}
