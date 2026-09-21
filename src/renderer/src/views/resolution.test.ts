import { describe, expect, it } from 'vitest'
import { availableViews, resolveView } from './resolution'
import type { Session } from '../../../shared/session-model'
import type { PluginRecord } from '../../../main/plugins/plugin-store'

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'session',
  provider: 'claude',
  transport: 'events',
  cwd: '/project',
  windowKey: 'main',
  state: 'idle',
  createdAt: 0,
  adapterId: 'claude-chat',
  title: 'project',
  ...patch
})
const plugin = (patch: Record<string, unknown> = {}): PluginRecord =>
  ({
    id: 'clave.chat-view',
    source: 'bundled',
    enabled: true,
    status: 'active',
    permissionsGranted: ['sessions.read', 'sessions.write'],
    manifest: {
      id: 'clave.chat-view',
      name: 'Chat',
      ui: 'native',
      contributes: {
        views: [
          { id: 'chat', title: 'Chat', renders: ['events'] },
          { id: 'compact', title: 'Compact', renders: ['events'] }
        ]
      }
    },
    ...patch
  }) as unknown as PluginRecord
const both: ReadonlySet<string> = new Set(['clave.chat-view/chat', 'clave.chat-view/compact'])

describe('view resolution', () => {
  it('offers one entry per contributed view, keyed by plugin and view', () => {
    expect(availableViews(session(), [plugin()], both)).toEqual([
      { id: 'clave.chat-view/chat', title: 'Chat', pluginName: 'Chat', kind: 'native' },
      { id: 'clave.chat-view/compact', title: 'Compact', pluginName: 'Chat', kind: 'native' }
    ])
  })
  it('resolves the view the session names', () => {
    expect(resolveView(session({ viewId: 'clave.chat-view/compact' }), [plugin()], both)).toBe(
      'clave.chat-view/compact'
    )
  })
  it('falls back to the first matching view when the session names none', () => {
    expect(resolveView(session(), [plugin()], both)).toBe('clave.chat-view/chat')
  })
  it('falls back rather than stranding a session on a view that is gone', () => {
    const manifest = {
      id: 'clave.chat-view',
      name: 'Chat',
      ui: 'native',
      contributes: { views: [{ id: 'chat', title: 'Chat', renders: ['events'] }] }
    }
    expect(
      resolveView(session({ viewId: 'clave.chat-view/compact' }), [plugin({ manifest })], both)
    ).toBe('clave.chat-view/chat')
  })
  it('falls back to the terminal when the plugin is disabled', () => {
    expect(
      resolveView(session({ viewId: 'clave.chat-view/chat' }), [plugin({ enabled: false })], both)
    ).toBeUndefined()
  })
  it('never offers a view this build cannot mount', () => {
    expect(availableViews(session(), [plugin()], new Set(['clave.chat-view/chat']))).toEqual([
      { id: 'clave.chat-view/chat', title: 'Chat', pluginName: 'Chat', kind: 'native' }
    ])
    expect(
      resolveView(session({ viewId: 'clave.chat-view/compact' }), [plugin()], new Set())
    ).toBeUndefined()
  })
  it('names a view by its id when the manifest gives no title', () => {
    const manifest = {
      id: 'clave.chat-view',
      name: 'Chat',
      ui: 'native',
      contributes: { views: [{ id: 'chat', renders: ['events'] }] }
    }
    expect(availableViews(session(), [plugin({ manifest })], both)[0].title).toBe('chat')
  })
  it('offers only the views that render THIS session, not every view the plugin has', () => {
    const manifest = {
      id: 'clave.chat-view',
      name: 'Chat',
      ui: 'native',
      contributes: {
        views: [
          { id: 'chat', title: 'Chat', renders: ['pty'] },
          { id: 'compact', title: 'Compact', renders: ['events'] }
        ]
      }
    }
    // The per-view filter, not the early return: this session IS an events one.
    expect(availableViews(session(), [plugin({ manifest })], both)).toEqual([
      { id: 'clave.chat-view/compact', title: 'Compact', pluginName: 'Chat', kind: 'native' }
    ])
    expect(
      resolveView(session({ viewId: 'clave.chat-view/chat' }), [plugin({ manifest })], both)
    ).toBe('clave.chat-view/compact')
  })
  it('offers nothing to a PTY session, whatever a manifest claims', () => {
    const manifest = {
      id: 'clave.chat-view',
      name: 'Chat',
      ui: 'native',
      contributes: { views: [{ id: 'chat', title: 'Chat', renders: ['pty', 'events'] }] }
    }
    expect(availableViews(session({ transport: 'pty' }), [plugin({ manifest })], both)).toEqual([])
  })
  it('refuses a native view from a plugin missing a grant, stopped, broken, or merely linked', () => {
    expect(
      resolveView(session(), [plugin({ permissionsGranted: ['sessions.read'] })], both)
    ).toBeUndefined()
    expect(resolveView(session(), [plugin({ source: 'linked' })], both)).toBeUndefined()
    expect(resolveView(session(), [plugin({ status: 'stopped' })], both)).toBeUndefined()
    expect(resolveView(session(), [plugin({ error: 'crashed' })], both)).toBeUndefined()
  })
  describe('surface views', () => {
    const surface = (patch: Record<string, unknown> = {}): PluginRecord =>
      plugin({
        id: 'vendor.board',
        source: 'linked',
        manifest: {
          id: 'vendor.board',
          name: 'Board',
          ui: 'surface',
          uiEntry: 'ui/index.html',
          contributes: { views: [{ id: 'board', title: 'Board', renders: ['events'] }] }
        },
        ...patch
      })
    it('are offered by a LINKED plugin, which native views never are', () => {
      expect(availableViews(session(), [surface()], new Set())).toEqual([
        { id: 'vendor.board/board', title: 'Board', pluginName: 'Board', kind: 'surface' }
      ])
    })
    it('need no compiled component: the native map does not gate them', () => {
      expect(resolveView(session({ viewId: 'vendor.board/board' }), [surface()], new Set())).toBe(
        'vendor.board/board'
      )
    })
    it('need a page to render and the read grant to be listed at all', () => {
      const noEntry = {
        id: 'vendor.board',
        name: 'Board',
        ui: 'surface',
        contributes: { views: [{ id: 'board', title: 'Board', renders: ['events'] }] }
      }
      expect(availableViews(session(), [surface({ manifest: noEntry })], new Set())).toEqual([])
      expect(availableViews(session(), [surface({ permissionsGranted: [] })], new Set())).toEqual(
        []
      )
      expect(availableViews(session(), [surface({ enabled: false })], new Set())).toEqual([])
      expect(availableViews(session(), [surface({ status: 'starting' })], new Set())).toEqual([])
    })
    it('are listed WITHOUT the write grant — writing is checked in main, per call', () => {
      expect(
        availableViews(session(), [surface({ permissionsGranted: ['sessions.read'] })], new Set())
      ).toHaveLength(1)
    })
  })
})
