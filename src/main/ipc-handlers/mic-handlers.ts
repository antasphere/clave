import { ipcMain } from 'electron'
import {
  MIC_GET_ACCESS_CHANNEL,
  MIC_REQUEST_ACCESS_CHANNEL,
  MIC_OPEN_SETTINGS_CHANNEL
} from '../../shared/mic'
import { getMicAccessState, requestMicAccess, openMicPrivacySettings } from '../mic-access'

/**
 * The Audio settings page's OS surface: report the real microphone permission,
 * run the macOS prompt, deep-link the privacy pane. System state, not session
 * state, so it sits beside the other app-level handlers.
 */
export function registerMicHandlers(): void {
  ipcMain.handle(MIC_GET_ACCESS_CHANNEL, () => getMicAccessState())
  ipcMain.handle(MIC_REQUEST_ACCESS_CHANNEL, () => requestMicAccess())
  ipcMain.handle(MIC_OPEN_SETTINGS_CHANNEL, () => openMicPrivacySettings())
}
