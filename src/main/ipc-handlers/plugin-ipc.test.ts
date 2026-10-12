import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The IPC arms of the plugins domain (PRDCT-3433): what stays the shell's
 * around a service that may live in this process or on an attached server.
 * The service itself is `plugins/plugin-service.test.ts`'s subject; here it
 * is a fake, and the arms are proven on what they add: the page's URL
 * minted by the preview protocol, the lease dropped when the window reloads,
 * the window's key on a focus report and its clearing when the window
 * closes, the folder dialog of "Link folder…", the notification shown once
 * per event, the guest frame refused everywhere, and the attached road
 * through the typed client.
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  fromWebContents: vi.fn(),
  showOpenDialog: vi.fn(),
  notifications: [] as { title: string; body: string }[],
  registered: [] as { file: string; csp?: string }[],
  keyForWindow: vi.fn(() => 'w1'),
  endpoint: { mode: 'in-process' } as { mode: string } | null,
  shell: {
    list: vi.fn(() => [{ id: 'p' }]),
    enable: vi.fn(),
    disable: vi.fn(),
    link: vi.fn(() => 'linked.plugin'),
    remove: vi.fn(),
    command: vi.fn(async () => undefined),
    panel: vi.fn(() => ({ file: '/plugins/p/ui/index.html', csp: "default-src 'self'" })),
    context: vi.fn(),
    leaseView: vi.fn(() => ({
      leaseId: 'lease-1',
      sessionId: 's1',
      file: '/plugins/p/ui/view.html',
      csp: "default-src 'self'; frame-src 'none'"
    })),
    requestView: vi.fn(() => ({ id: 's1' })),
    revokeView: vi.fn(),
    secrets: vi.fn(() => []),
    replySecret: vi.fn()
  },
  remote: {
    plugins: {
      list: vi.fn(async () => [{ id: 'remote' }]),
      context: vi.fn(async () => undefined)
    }
  }
}))
vi.mock('electron', () => ({
  app: { once: vi.fn() },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: (name: string, fn: never) => mocks.handlers.set(name, fn) },
  Notification: class {
    constructor(private readonly options: { title: string; body: string }) {}
    static isSupported(): boolean {
      return true
    }
    show(): void {
      mocks.notifications.push(this.options)
    }
  }
}))
vi.mock('../test-mode', () => ({ TEST_NO_ACTIVATE: false, OWN_PROFILE: false }))
vi.mock('../window-registry', () => ({
  windowRegistry: { getKeyForWindow: mocks.keyForWindow }
}))
vi.mock('../preview-protocol', () => ({
  registerPreviewFile: (file: string, csp?: string) => {
    mocks.registered.push({ file, ...(csp !== undefined && { csp }) })
    return { url: `clave-preview://token/${file.split('/').pop()}` }
  }
}))
vi.mock('../server/endpoint', () => ({
  whenClaveServerBootSettled: async () => true,
  getClaveServerEndpoint: () => mocks.endpoint
}))
vi.mock('../mcp/server-client', () => ({
  serverClient: { api: async () => mocks.remote }
}))
vi.mock('../plugins/shell-plugins', () => ({ shellPlugins: () => mocks.shell }))

import { registerPluginHandlers } from './plugin-ipc'

/** A window as the arms see it: its web contents, its frames, its events. */
function makeWindow(id = 1): {
  win: Record<string, unknown>
  event: { sender: unknown; senderFrame: unknown }
  guestEvent: { sender: unknown; senderFrame: unknown }
  emit: (name: string) => void
  listeners: Map<string, ((...args: unknown[]) => void)[]>
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const add = (name: string, fn: (...args: unknown[]) => void): void => {
    listeners.set(name, [...(listeners.get(name) ?? []), fn])
  }
  const mainFrame = { id: 'main' }
  const webContents = {
    mainFrame,
    on: add,
    once: add,
    off: (name: string, fn: (...args: unknown[]) => void) =>
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((f) => f !== fn)
      )
  }
  const win = {
    id,
    webContents,
    isDestroyed: () => false,
    once: add
  }
  const sender = { mainFrame }
  return {
    win,
    event: { sender, senderFrame: mainFrame },
    guestEvent: { sender, senderFrame: { id: 'guest' } },
    emit: (name) => {
      for (const fn of listeners.get(name) ?? []) fn()
    },
    listeners
  }
}
/** A handler as ipcMain invokes it: a synchronous throw is a rejection too. */
const invoke = (channel: string, event: unknown, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve().then(() =>
    (mocks.handlers.get(channel) as (...a: unknown[]) => unknown)(event, ...args)
  )
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let window: ReturnType<typeof makeWindow>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.registered.length = 0
  mocks.notifications.length = 0
  mocks.endpoint = { mode: 'in-process' }
  window = makeWindow()
  mocks.fromWebContents.mockImplementation(() => window.win)
  registerPluginHandlers()
})

describe('the plugin IPC arms around the service', () => {
  it("mints a lease's URL from the page the service named, and drops the lease when the window reloads", async () => {
    const granted = await invoke('plugins:view-lease', window.event, 'p', 'log', 's1')
    expect(mocks.shell.leaseView).toHaveBeenCalledWith('p', 'log', 's1')
    expect(granted).toEqual({
      leaseId: 'lease-1',
      url: 'clave-preview://token/view.html',
      sessionId: 's1'
    })
    expect(mocks.registered).toEqual([
      { file: '/plugins/p/ui/view.html', csp: "default-src 'self'; frame-src 'none'" }
    ])
    window.emit('did-navigate')
    await flush()
    expect(mocks.shell.revokeView).toHaveBeenCalledWith('lease-1')
    // The drop fired once: the listeners went with it.
    expect(window.listeners.get('did-navigate')).toEqual([])
  })
  it('revokes through the service and forgets the reload drop', async () => {
    await invoke('plugins:view-lease', window.event, 'p', 'log', 's1')
    await invoke('plugins:view-revoke', window.event, 'lease-1')
    expect(mocks.shell.revokeView).toHaveBeenCalledTimes(1)
    window.emit('did-navigate')
    await flush()
    expect(mocks.shell.revokeView).toHaveBeenCalledTimes(1)
  })
  it("mints a panel's URL, and a preview URL only from a file and a policy", async () => {
    expect(await invoke('plugins:panel', window.event, 'p', 'side')).toEqual({
      url: 'clave-preview://token/index.html'
    })
    expect(mocks.registered[0]).toEqual({
      file: '/plugins/p/ui/index.html',
      csp: "default-src 'self'"
    })
    expect(await invoke('plugins:preview-url', window.event, '/plugins/p/ui/a.html', 'x')).toEqual({
      url: 'clave-preview://token/a.html'
    })
    await expect(invoke('plugins:preview-url', window.event, '', 'x')).rejects.toThrow(
      'a file and a policy'
    )
  })
  it('keys a focus report by the window and clears it when the window closes', async () => {
    await invoke('plugins:context', window.event, 's1')
    expect(mocks.shell.context).toHaveBeenCalledWith('w1', 's1')
    window.emit('closed')
    await flush()
    expect(mocks.shell.context).toHaveBeenLastCalledWith('w1', null)
  })
  it('shows the folder dialog only when no folder was given', async () => {
    mocks.showOpenDialog.mockResolvedValueOnce({ filePaths: ['/picked'] })
    expect(await invoke('plugins:link', window.event)).toBe('linked.plugin')
    expect(mocks.shell.link).toHaveBeenCalledWith('/picked')
    expect(await invoke('plugins:link', window.event, '/given')).toBe('linked.plugin')
    expect(mocks.shell.link).toHaveBeenLastCalledWith('/given')
    expect(mocks.showOpenDialog).toHaveBeenCalledTimes(1)
    mocks.showOpenDialog.mockResolvedValueOnce({ filePaths: [] })
    expect(await invoke('plugins:link', window.event)).toBeNull()
  })
  it('shows a relayed notification once per event, whichever windows relay it', async () => {
    await invoke('plugins:show-notification', window.event, 'e1', 'Hello', 'Done', 'All good')
    await invoke('plugins:show-notification', window.event, 'e1', 'Hello', 'Done', 'All good')
    await invoke('plugins:show-notification', window.event, 'e2', 'Hello', 'Again')
    expect(mocks.notifications).toEqual([
      { title: 'Hello: Done', body: 'All good' },
      { title: 'Hello: Again', body: '' }
    ])
  })
  it('refuses a guest frame on every arm', async () => {
    for (const channel of [
      'plugins:list',
      'plugins:view-lease',
      'plugins:view-request',
      'plugins:preview-url',
      'plugins:context',
      'plugins:secrets',
      'plugins:show-notification'
    ])
      await expect(invoke(channel, window.guestEvent, 'x', 'y', 'z')).rejects.toThrow(
        'requires the app renderer'
      )
    expect(mocks.shell.leaseView).not.toHaveBeenCalled()
    expect(mocks.registered).toEqual([])
  })
  it('answers from the attached server once the boot named one', async () => {
    mocks.endpoint = { mode: 'attached' }
    expect(await invoke('plugins:list', window.event)).toEqual([{ id: 'remote' }])
    expect(mocks.shell.list).not.toHaveBeenCalled()
    await invoke('plugins:context', window.event, null)
    expect(mocks.remote.plugins.context).toHaveBeenCalledWith('w1', null)
  })
})
