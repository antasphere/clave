import { ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'
import { isElevenLabsModelId } from '../../shared/elevenlabs'

/** This Mac's integrations over IPC (PRDCT-4410), from the same settings
 *  source the server answers from. The key travels once, in, and is
 *  answered with the status; nothing here logs a payload. */
export function registerIntegrationsHandlers(): void {
  ipcMain.handle('integrations:read', () => settings.integrations.read())
  ipcMain.handle('integrations:elevenlabs-set-key', (_event, apiKey: unknown) => {
    if (typeof apiKey !== 'string') throw new Error('Paste the API key first.')
    return settings.integrations.setElevenLabsKey(apiKey)
  })
  ipcMain.handle('integrations:elevenlabs-check', () => settings.integrations.checkElevenLabs())
  ipcMain.handle('integrations:elevenlabs-remove', () =>
    settings.integrations.removeElevenLabsKey()
  )
  ipcMain.handle(
    'integrations:elevenlabs-set-voice',
    (_event, value: { voiceId: unknown; voiceName: unknown; modelId?: unknown }) => {
      if (typeof value?.voiceId !== 'string' || typeof value?.voiceName !== 'string')
        throw new Error('That is not a voice.')
      if (value.modelId !== undefined && !isElevenLabsModelId(value.modelId))
        throw new Error('That is not an ElevenLabs model.')
      return settings.integrations.setElevenLabsVoice(value.voiceId, value.voiceName, value.modelId)
    }
  )
  ipcMain.handle('integrations:elevenlabs-voices', () =>
    settings.integrations.listElevenLabsVoices()
  )
}
