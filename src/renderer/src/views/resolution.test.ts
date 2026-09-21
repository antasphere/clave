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
      { id: 'clave.chat-view/chat', title: 'Chat', pluginName: 'Chat' },
      { id: 'clave.chat-view/compact', title: 'Compact', pluginName: 'Chat' }
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
      { id: 'clave.chat-view/chat', title: 'Chat', pluginName: 'Chat' }
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
  it('offers nothing to a PTY session, whatever a manifest claims', () => {
    const manifest = {
      id: 'clave.chat-view',
      name: 'Chat',
      ui: 'native',
      contributes: { views: [{ id: 'chat', title: 'Chat', renders: ['pty', 'events'] }] }
    }
    expect(availableViews(session({ transport: 'pty' }), [plugin({ manifest })], both)).toEqual([])
  })
  it('refuses a plugin missing either session grant, a surface plugin, and a linked one', () => {
    expect(
      resolveView(session(), [plugin({ permissionsGranted: ['sessions.read'] })], both)
    ).toBeUndefined()
    expect(
      resolveView(session(), [plugin({ manifest: { ...plugin().manifest, ui: 'surface' } })], both)
    ).toBeUndefined()
    expect(resolveView(session(), [plugin({ source: 'linked' })], both)).toBeUndefined()
    expect(resolveView(session(), [plugin({ status: 'stopped' })], both)).toBeUndefined()
    expect(resolveView(session(), [plugin({ error: 'crashed' })], both)).toBeUndefined()
  })
})
