/**
 * The `.clave` IPC arms over the shell's one instance: a watched file's
 * change is fanned out to every window over IPC (a window on the server
 * hears the push channel instead; the preload keeps one of the two), the
 * watch is held under the name the window gave, and a read with no server
 * reviews on the asking window through the shell's dialog. Round 1 of the
 * lane's verifier removed the fan-out and nothing went red; this is the pin.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const sent: Array<{ id: number; channel: string; payload: unknown }> = []
const dialogs: Array<{ message: string; detail: string }> = []
let dialogAnswer = { response: 2, checkboxChecked: false }
const win = (
  id: number
): {
  id: number
  isDestroyed: () => boolean
  webContents: { id: number; send: (c: string, p: unknown) => void }
} => ({
  id,
  isDestroyed: () => false,
  webContents: { id: id + 10, send: (channel, payload) => sent.push({ id, channel, payload }) }
})
const windows = [win(1), win(2)]
const userData = realpathSync(mkdtempSync(join(tmpdir(), 'clave-wsf-ipc-')))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: never) => handlers.set(channel, fn) },
  app: { getPath: () => userData },
  dialog: {
    showMessageBox: async (_win: unknown, opts: { message: string; detail: string }) => {
      dialogs.push({ message: opts.message, detail: opts.detail })
      return dialogAnswer
    },
    showSaveDialog: async () => ({ canceled: true })
  },
  BrowserWindow: {
    fromWebContents: (wc: { id: number }) => windows.find((w) => w.webContents.id === wc.id) ?? null
  }
}))
vi.mock('../window-registry', () => ({
  windowRegistry: { listWindows: () => windows }
}))

const { registerClaveFileHandlers, cleanupClaveWatchers } = await import('./clave-file-handlers')
const { workspaceFiles } = await import('../workspace-files')

const call = (channel: string, sender: number, ...args: unknown[]): unknown => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender: { id: sender } }, ...args)
}
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const clave = (name: string, prompt?: string): string =>
  JSON.stringify({ name, cwd: '.', ...(prompt && { prompt }), sessions: [], terminals: [] })

let root: string
beforeEach(() => {
  handlers.clear()
  sent.length = 0
  dialogs.length = 0
  root = realpathSync(mkdtempSync(join(tmpdir(), 'clave-wsf-ipc-root-')))
  registerClaveFileHandlers()
})
afterEach(() => {
  cleanupClaveWatchers()
  rmSync(root, { recursive: true, force: true })
})

describe('the .clave IPC arms', () => {
  it('fans a watched file’s change out to every window over IPC, once', async () => {
    const file = join(root, 'w.clave')
    writeFileSync(file, clave('A'))
    await call('clave:watch-file', 11, file, 'ipc:one')
    await settle(100)
    writeFileSync(file, clave('B'))
    await settle(900)
    expect(sent).toEqual([
      { id: 1, channel: 'clave:file-changed', payload: file },
      { id: 2, channel: 'clave:file-changed', payload: file }
    ])
  })

  it('holds the watch under the window’s name, or its web contents, and keeps it for the other holder', async () => {
    const file = join(root, 'h.clave')
    writeFileSync(file, clave('A'))
    await call('clave:watch-file', 11, file, 'ipc:one')
    await call('clave:watch-file', 21, file)
    expect(workspaceFiles().holdersOf(file).sort()).toEqual(['ipc:one', 'webContents:21'])
    await call('clave:unwatch-file', 11, file, 'ipc:one')
    expect(workspaceFiles().watched()).toEqual([file])
    await call('clave:unwatch-file', 21, file)
    expect(workspaceFiles().watched()).toEqual([])
  })

  it('reviews an elevated untrusted file on the asking window with the shell’s dialog', async () => {
    const file = join(root, 'e.clave')
    writeFileSync(file, clave('Lane', 'UNTRUSTED-BRIEF do the thing'))
    dialogAnswer = { response: 2, checkboxChecked: false }
    expect(await call('clave:read-file', 11, file)).toBeNull()
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].message).toBe('“e.clave” wants to run content automatically.')
    expect(dialogs[0].detail).toContain('UNTRUSTED-BRIEF do the thing')
    dialogAnswer = { response: 0, checkboxChecked: false }
    const safe = (await call('clave:read-file', 11, file)) as { prompt?: string; name: string }
    expect(safe.name).toBe('Lane')
    expect(safe.prompt).toBeUndefined()
    // The server's road asks the same dialog through this arm.
    dialogAnswer = { response: 1, checkboxChecked: true }
    const answer = await call('clave:review-dialog', 11, {
      path: file,
      folder: root,
      autoCommands: [],
      prompts: ['P'],
      dangerous: false
    })
    expect(answer).toEqual({ response: 1, checkboxChecked: true })
    expect(dialogs).toHaveLength(3)
  })
})
