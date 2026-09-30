import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../shared/session-model'

/**
 * The plugin view lease, checked where it is decided: in main.
 *
 * A surface view is a page the host does not trust, so everything that keeps it
 * honest lives here — the session it may read is fixed when the lease is
 * granted, the calling window must be the one that holds it, and the plugin's
 * grants are read again on EVERY call rather than at the lease's birth. The
 * end-to-end spec drives the same code through a real frame; these tests reach
 * the cases a single window and a single guest cannot produce.
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  fromWebContents: vi.fn(),
  getAllWindows: vi.fn(() => []),
  keyForWindow: vi.fn(),
  record: {} as Record<string, unknown>,
  session: null as Session | null,
  writes: [] as { id: string; input: unknown }[],
  subscribed: [] as string[],
  registered: [] as string[],
  unregistered: [] as string[]
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/clave-lease-test',
    getAppPath: () => '/tmp/clave-lease-test/app',
    getVersion: () => '1.90.2',
    isPackaged: false,
    once: vi.fn()
  },
  BrowserWindow: { fromWebContents: mocks.fromWebContents, getAllWindows: mocks.getAllWindows },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: (name: string, fn: never) => mocks.handlers.set(name, fn) },
  Notification: { isSupported: () => false }
}))
// The store and the host are stubs: this file is about the lease, and every
// method it does not exercise records the call and returns nothing.
const noop = (): void => {
  /* the handlers under test call these; what they do is another file's subject */
}
vi.mock('../plugins/plugin-store', () => ({
  pluginFile: (root: string, entry: string) => `${root}/${entry}`,
  PluginStore: class {
    discover = noop
    get(): Record<string, unknown> {
      return mocks.record
    }
    list(): unknown[] {
      return [mocks.record]
    }
  }
}))
vi.mock('../plugins/plugin-host', () => ({
  PluginHost: class {
    startAll = noop
    start = noop
    stop = noop
    close = noop
    reload = noop
  }
}))
vi.mock('../pty-manager', () => ({
  ptyManager: { getAllSessions: () => [], getSession: () => null }
}))
vi.mock('../preview-protocol', () => ({
  registerPreviewFile: (file: string) => {
    mocks.registered.push(file)
    return { url: `clave-preview://token/${file}` }
  },
  unregisterPreviewFile: (file: string) => mocks.unregistered.push(file)
}))
vi.mock('../test-mode', () => ({ TEST_NO_ACTIVATE: true }))
vi.mock('../window-registry', () => ({
  windowRegistry: { getKeyForWindow: mocks.keyForWindow }
}))
vi.mock('../sessions/session-manager', () => ({
  sessionManager: {
    get: () => mocks.session,
    ready: vi.fn(),
    write: (id: string, input: unknown) => mocks.writes.push({ id, input }),
    subscribe: (id: string) => {
      mocks.subscribed.push(id)
      return () => {}
    }
  }
}))
import { registerPluginHandlers } from './plugin-ipc'

const LEASED = 'leased-session'
const OTHER = 'another-session'
const WINDOW = {
  id: 1,
  isDestroyed: () => false,
  webContents: { on: vi.fn(), once: vi.fn(), off: vi.fn(), send: vi.fn() }
}
const sender = { id: 7 }
const event = { sender, senderFrame: 'frame' } as never
const grantedPlugin = (
  permissionsGranted: string[] = ['sessions.read', 'sessions.write']
): Record<string, unknown> => ({
  id: 'vendor.board',
  directory: '/plugins/board',
  enabled: true,
  status: 'active',
  permissionsGranted,
  manifest: {
    id: 'vendor.board',
    name: 'Board',
    ui: 'surface',
    uiEntry: 'ui/index.html',
    contributes: { views: [{ id: 'board', title: 'Board', renders: ['events'] }] }
  }
})
const call = (name: string, ...args: unknown[]): unknown =>
  (mocks.handlers.get(name) as (...a: unknown[]) => unknown)(event, ...args)
const mint = (): { leaseId: string } =>
  call('plugins:view-lease', 'vendor.board', 'board', LEASED) as { leaseId: string }

beforeEach(() => {
  mocks.handlers.clear()
  mocks.writes.length = 0
  mocks.registered.length = 0
  mocks.unregistered.length = 0
  mocks.record = grantedPlugin()
  mocks.session = {
    id: LEASED,
    provider: 'claude',
    transport: 'events',
    cwd: '/project',
    windowKey: 'main',
    state: 'idle',
    createdAt: 0,
    adapterId: 'claude-chat',
    title: 'project'
  }
  // `event.senderFrame === event.sender.mainFrame` is the app-renderer guard.
  mocks.fromWebContents.mockReturnValue({ ...WINDOW, webContents: { ...WINDOW.webContents } })
  Object.assign(sender, { mainFrame: 'frame' })
  mocks.keyForWindow.mockReturnValue('main')
  registerPluginHandlers()
})

describe('the plugin view lease', () => {
  it('fixes the session at the mint and writes only to it, whatever a guest names', () => {
    const { leaseId } = mint()
    call('plugins:view-request', leaseId, 'session.write', {
      type: 'user_message',
      text: 'hello',
      sessionId: OTHER,
      id: OTHER
    })
    expect(mocks.writes).toEqual([{ id: LEASED, input: { type: 'user_message', text: 'hello' } }])
  })
  it('refuses a lease held by another window, and a session owned by one', () => {
    const { leaseId } = mint()
    mocks.fromWebContents.mockReturnValue({
      ...WINDOW,
      id: 2,
      webContents: { ...WINDOW.webContents }
    })
    expect(() => call('plugins:view-request', leaseId, 'session.get')).toThrow('Unknown view lease')
    // And the mint itself refuses a session that lives in another window.
    mocks.keyForWindow.mockReturnValue('second-window')
    expect(() => mint()).toThrow('another window')
  })
  it('reads the grants again on every call, not once at the lease', () => {
    const { leaseId } = mint()
    expect(call('plugins:view-request', leaseId, 'session.get')).toMatchObject({ id: LEASED })
    // The write grant is taken away while the lease lives on.
    mocks.record = grantedPlugin(['sessions.read'])
    expect(() =>
      call('plugins:view-request', leaseId, 'session.write', { type: 'user_message', text: 'x' })
    ).toThrow('may not write')
    expect(mocks.writes).toEqual([])
    // Reading survives it; the lease is not revoked, only narrowed.
    expect(call('plugins:view-request', leaseId, 'session.get')).toMatchObject({ id: LEASED })
    // The plugin is switched off: the lease answers nothing at all.
    mocks.record = { ...grantedPlugin(), enabled: false }
    expect(() => call('plugins:view-request', leaseId, 'session.get')).toThrow('not active')
  })
  it('answers no method but the two it owns', () => {
    const { leaseId } = mint()
    for (const method of ['sessionsList', 'session.kill', 'plugins:list', ''])
      expect(() => call('plugins:view-request', leaseId, method)).toThrow(
        'Unknown plugin view method'
      )
  })
  it('refuses to open a view a plugin never declared, or one that cannot render this session', () => {
    expect(() => call('plugins:view-lease', 'vendor.board', 'absent', LEASED)).toThrow(
      'Undeclared view'
    )
    mocks.record = {
      ...grantedPlugin(),
      manifest: {
        ...(grantedPlugin().manifest as Record<string, unknown>),
        contributes: { views: [{ id: 'board', title: 'Board', renders: ['pty'] }] }
      }
    }
    expect(() => mint()).toThrow('does not render this transport')
  })
  it('refuses to open one without the read grant, or from a plugin with no page', () => {
    mocks.record = grantedPlugin([])
    expect(() => mint()).toThrow('may not read sessions')
    mocks.record = {
      ...grantedPlugin(),
      manifest: { ...(grantedPlugin().manifest as Record<string, unknown>), uiEntry: undefined }
    }
    expect(() => mint()).toThrow('View is not active')
  })
  it('stops serving the revoked page, and keeps serving one another lease still shows', () => {
    const first = mint()
    const second = mint()
    call('plugins:view-revoke', first.leaseId)
    expect(mocks.unregistered).toEqual([])
    call('plugins:view-revoke', second.leaseId)
    expect(mocks.unregistered).toEqual(['/plugins/board/ui/index.html'])
    // A revoked lease answers nothing afterwards.
    expect(() => call('plugins:view-request', second.leaseId, 'session.get')).toThrow(
      'Unknown view lease'
    )
  })
})
