import { ipcMain } from 'electron'
import { requestDigest } from '../exchange-digest'
import type { DigestRequest } from '../../shared/exchange-digest'

/** The exchange timeline asks what the reader needs from a run of messages
 *  other tabs sent (`src/main/exchange-digest.ts`). A failure is a result,
 *  never a rejection: the timeline then shows no digest, only the messages. */
export function registerExchangeDigestHandlers(): void {
  ipcMain.handle('exchanges:digest', (_event, request: DigestRequest) => requestDigest(request))
}
