import { ipcMain } from 'electron'
import { registerPreviewFile } from '../preview-protocol'

export function registerPreviewHandlers(): void {
  // Register an HTML file with the preview protocol; returns its clave-preview URL.
  ipcMain.handle('preview:register', (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
      throw new Error('preview:register requires an absolute file path')
    }
    return registerPreviewFile(filePath)
  })
}
