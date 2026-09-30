import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { sessionManager } from './session-manager'
import { listPluginSessions, pluginSessionById, pluginSessionOf } from './plugin-sessions'
import type { SessionAdapter, SessionAdapterEvents, SessionHandle, Unsubscribe } from './adapter'
import type { Session } from '../../shared/session-model'

/**
 * The plugin host's view of a session comes from the registry, so a session that
 * never went near the PTY manager is visible to a plugin and can be the focused
 * one. These build such a session directly, the way an events adapter does.
 */
let n = 0
class StubAdapter implements SessionAdapter {
  readonly provider = 'stub'
  readonly transports = ['events'] as const
  private emitters = new Map<string, EventEmitter>()
  constructor(readonly id: string) {}
  async spawn(spec: Session): Promise<SessionHandle> {
    this.emitters.set(spec.id, new EventEmitter())
    return { id: spec.id }
  }
  async attach(id: string): Promise<SessionHandle> {
    return { id }
  }
  write(): void {
    /* The registry is what these tests read; nothing is sent anywhere. */
  }
  kill(): void {
    /* No process behind this adapter to end. */
  }
  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): Unsubscribe {
    const emitter = this.emitters.get(handle.id) ?? new EventEmitter()
    this.emitters.set(handle.id, emitter)
    emitter.on(event, callback)
    return () => {
      emitter.off(event, callback)
    }
  }
}

/** A live events session in the registry, created without the PTY manager. */
function registrySession(cwd = '/Users/someone/work/my-project'): Session {
  const adapter = new StubAdapter(`stub-${++n}`)
  sessionManager.registerAdapter(adapter)
  const record: Session = {
    id: `plugin-session-${n}`,
    provider: adapter.provider,
    transport: 'events',
    cwd,
    windowKey: 'w1',
    state: 'idle',
    createdAt: 1,
    adapterId: adapter.id,
    title: 'work'
  }
  return sessionManager.adopt(record, { id: record.id }, adapter)
}

describe('the plugin host view of a session', () => {
  it('reports a session the registry created, which never went through the PTY manager', () => {
    const session = registrySession()
    const reported = pluginSessionById(session.id)
    expect(reported).toEqual({
      id: session.id,
      cwd: '/Users/someone/work/my-project',
      folderName: 'my-project',
      alive: true
    })
    // The same session is in the listing, so `focused` and `list` agree about it.
    expect(listPluginSessions()).toContainEqual(reported)
    sessionManager.forget(session.id)
  })

  it('stops calling it alive once the record has ended', () => {
    const session = registrySession()
    expect(pluginSessionById(session.id)?.alive).toBe(true)
    sessionManager.setState(session.id, 'ended')
    expect(pluginSessionById(session.id)?.alive).toBe(false)
    sessionManager.forget(session.id)
    expect(pluginSessionById(session.id)).toBeNull()
  })

  it.each([
    ['/Users/someone/work/my-project', 'my-project'],
    ['/Users/someone/work/my-project/', 'my-project'],
    ['/', '/'],
    ['C:\\Users\\someone\\work', 'work']
  ])('names the folder of %s as %s', (cwd, folderName) => {
    expect(pluginSessionOf({ cwd } as Session).folderName).toBe(folderName)
  })
})
