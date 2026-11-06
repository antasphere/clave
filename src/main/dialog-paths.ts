import { app, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import path from 'node:path'

/**
 * Where a file dialog opens. Since Electron 43 a dialog given no
 * `defaultPath` opens in Downloads, where before macOS brought back the
 * folder the person last browsed. This keeps that: the folder of the last
 * pick, per kind of dialog (a project folder, a keymap, an attachment…),
 * for the life of the process; the home folder the first time. A caller
 * that names a `defaultPath` of its own is left alone.
 */
export interface OpenDialogLike {
  show(
    win: BrowserWindow | undefined,
    options: OpenDialogOptions
  ): Promise<{ canceled: boolean; filePaths: string[] }>
  home(): string
}

export function rememberedOpenDialogs(deps: OpenDialogLike): {
  open(
    kind: string,
    win: BrowserWindow | undefined,
    options: OpenDialogOptions
  ): Promise<{ canceled: boolean; filePaths: string[] }>
} {
  const lastDirectory = new Map<string, string>()
  return {
    async open(kind, win, options) {
      const defaultPath = options.defaultPath ?? lastDirectory.get(kind) ?? deps.home()
      const result = await deps.show(win, { ...options, defaultPath })
      const picked = result.filePaths[0]
      // The folder browsed, as macOS remembered it: the parent of a pick,
      // whether the pick is a file or a folder.
      if (!result.canceled && picked) lastDirectory.set(kind, path.dirname(picked))
      return result
    }
  }
}

/** The app's own dialogs, over Electron. */
export const openDialogs = rememberedOpenDialogs({
  show: (win, options) =>
    win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options),
  home: () => app.getPath('home')
})
