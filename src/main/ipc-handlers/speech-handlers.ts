import { ipcMain } from 'electron'
import { sessionLaunchOf } from '../exchange-digest'
import { ptyManager } from '../pty-manager'
import { serverLaunch } from '../server-launch'
import { hostSpeech, type HostSpeech } from '../speech'
import type { SpeakRequest, SpeakResult } from '../../shared/speech'

/** Folio's speech over IPC (PRDCT-4411), for a window whose server is main
 *  (in-process): the same host the server serves, on main's own record of
 *  the session and this Mac's ElevenLabs key. With a server of its own
 *  behind the window, the key is that server's and the window asks it
 *  (`viaOwnServer`); main has none to speak with. A failure is a result,
 *  never a rejection; nothing here logs a payload. */
const SPEECH_ON_SERVER: SpeakResult = {
  ok: false,
  error: "Speech runs on Clave's server.",
  reason: 'failed'
}

export function registerSpeechHandlers(): void {
  const owns = serverLaunch.mode === 'in-process'
  let host: HostSpeech | null = null
  const speech = (): HostSpeech => (host ??= hostSpeech(sessionLaunchOf(ptyManager)))
  ipcMain.handle('speech:speak', (_event, request: SpeakRequest): Promise<SpeakResult> => {
    if (!owns) return Promise.resolve(SPEECH_ON_SERVER)
    if (typeof request?.sessionId !== 'string' || typeof request?.text !== 'string')
      return Promise.resolve({ ok: false, error: 'Nothing to speak.', reason: 'failed' })
    return speech().speak({ sessionId: request.sessionId, text: request.text })
  })
  ipcMain.handle('speech:preview', (_event, voiceId: unknown): Promise<SpeakResult> => {
    if (!owns) return Promise.resolve(SPEECH_ON_SERVER)
    return speech().preview(typeof voiceId === 'string' ? voiceId : '')
  })
}
