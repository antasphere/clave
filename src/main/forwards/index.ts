/**
 * The forwards' IPC arm (PRDCT-4473): a window asks for a page a server
 * serves on its own loopback, by the server's id and the lease the server
 * gave, and gets back the local URL to frame. The secret of the listener and
 * the server's token stay in main: the answer is the URL and the key, and
 * the window gate (`window-gate.ts`) adds the secret to the window's requests.
 */
import { app, ipcMain, type WebContents } from 'electron'
import log from 'electron-log/main'
import { isForwardLease } from '@clave/contract/forward'
import { LoopbackForwards, type OpenedForward } from './loopback-forwards'

export const loopbackForwards = new LoopbackForwards({ log: (line) => log.info(line) })

/** What each window holds, by its `webContents.id`: key → the holds it took. */
const holds = new Map<number, Map<string, OpenedForward[]>>()

const releaseAll = (senderId: number): void => {
  const held = holds.get(senderId)
  if (!held) return
  holds.delete(senderId)
  for (const opened of held.values()) for (const one of opened) one.release()
}

/** A renderer that reloads or dies cannot release what it no longer
 *  remembers, so main lets go for it. `did-navigate` is the MAIN frame's,
 *  never a guest's, so a page loading inside a frame keeps its hold. */
const watchSender = (sender: WebContents): void => {
  if (holds.has(sender.id)) return
  holds.set(sender.id, new Map())
  const id = sender.id
  const drop = (): void => {
    releaseAll(id)
    if (sender.isDestroyed()) return
    sender.off('did-navigate', drop)
    sender.off('destroyed', drop)
  }
  sender.on('did-navigate', drop)
  sender.once('destroyed', drop)
}

export function registerForwardHandlers(
  endpointOf: (serverId: string) => Promise<{ url: string; token: string }>
): void {
  ipcMain.handle('forwards:open', async (event, serverId: unknown, lease: unknown) => {
    if (
      typeof serverId !== 'string' ||
      !serverId ||
      typeof lease !== 'string' ||
      !isForwardLease(lease)
    )
      throw new Error('A forward needs a server and a lease.')
    const key = `${serverId}:${lease}`
    const opened = await loopbackForwards.open({
      key,
      lease,
      upstream: () => endpointOf(serverId)
    })
    const sender = event.sender
    if (sender.isDestroyed()) {
      opened.release()
      throw new Error('The window that asked for this forward is gone.')
    }
    watchSender(sender)
    const held = holds.get(sender.id)!
    held.set(key, [...(held.get(key) ?? []), opened])
    return { url: opened.url, key }
  })

  ipcMain.handle('forwards:release', (event, key: unknown) => {
    if (typeof key !== 'string') return
    const held = holds.get(event.sender.id)
    const opened = held?.get(key)
    const one = opened?.pop()
    one?.release()
    if (held && opened && opened.length === 0) held.delete(key)
  })

  app.on('will-quit', () => {
    void loopbackForwards.closeAll()
  })
}
