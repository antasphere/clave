import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { registerPreviewFile } from '../preview-protocol'
import { cacheRemoteDeck } from '../routines/remote-decks'

export function registerPreviewHandlers(): void {
  // Register an HTML file with the preview protocol; returns its clave-preview URL.
  ipcMain.handle('preview:register', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
      throw new Error('preview:register requires an absolute file path')
    }
    return registerPreviewFile(filePath)
  })

  // A connected server's run deck (PRDCT-4149): the page the window read over
  // the server's API, written under this Mac's user data and served by the
  // preview protocol, the one origin the page guest takes a deck from.
  ipcMain.handle(
    'routines:cache-remote-deck',
    (_event, serverId: unknown, runId: unknown, html: unknown) => {
      if (typeof serverId !== 'string' || typeof runId !== 'string' || typeof html !== 'string')
        throw new Error('routines:cache-remote-deck requires a server id, a run id and a page')
      const file = cacheRemoteDeck(
        join(app.getPath('userData'), 'routines', 'remote-decks'),
        serverId,
        runId,
        html
      )
      return { url: registerPreviewFile(file).url }
    }
  )
}
