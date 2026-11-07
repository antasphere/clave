import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasServerEventPublisher,
  publishOrSend,
  sessionCleared,
  sessionPlanDetected,
  sessionTitleChanged,
  setServerEventPublisher
} from './session-events'
import {
  inMemorySessionWindows,
  installSessionWindows,
  type SessionWindowsPort
} from '../sessions/windows'

/** A windows port that records what the per-window arm sends, by key. */
const windows = (): { port: SessionWindowsPort; sent: unknown[][] } => {
  const sent: unknown[][] = []
  const port: SessionWindowsPort = {
    ...inMemorySessionWindows(),
    send: (windowKey, channel, ...args) => {
      if (windowKey === 'w1') sent.push([channel, ...args])
    }
  }
  installSessionWindows(port)
  return { port, sent }
}

afterEach(() => {
  setServerEventPublisher(null)
  installSessionWindows(null)
})

describe('a session’s news travels on one transport, never both', () => {
  it('goes to the window over IPC while no server runs', () => {
    const { sent } = windows()
    expect(hasServerEventPublisher()).toBe(false)
    sessionTitleChanged('s1', 'fix auth', 'w1')
    sessionPlanDetected('s1', '/tmp/plan.md', 'w1')
    sessionCleared('s1', 'rotated', 'w1')
    expect(sent).toEqual([
      ['session:auto-title:s1', 'fix auth'],
      ['session:plan-detected:s1', '/tmp/plan.md'],
      ['session:clear-detected:s1', 'rotated']
    ])
  })
  it('goes to the server as the right event, and not to the window, once a publisher is set', async () => {
    const { sent } = windows()
    const published: unknown[] = []
    setServerEventPublisher(async (event) => {
      published.push(event)
    })
    expect(hasServerEventPublisher()).toBe(true)
    sessionTitleChanged('s1', 'fix auth', 'w1')
    sessionPlanDetected('s1', '/tmp/plan.md', 'w1')
    sessionCleared('s1', null, 'w1')
    await Promise.resolve()
    expect(published).toEqual([
      { _tag: 'session.title_changed', id: 's1', title: 'fix auth' },
      { _tag: 'session.plan_detected', id: 's1', path: '/tmp/plan.md' },
      { _tag: 'session.cleared', id: 's1', providerSessionId: null }
    ])
    expect(sent).toEqual([])
  })
  it('a publisher that fails is logged, and the window is still not sent to', async () => {
    const { sent } = windows()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    setServerEventPublisher(async () => {
      throw new Error('socket gone')
    })
    publishOrSend({ _tag: 'session.title_changed', id: 's1', title: 't' }, () =>
      sent.push(['legacy'])
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])
    expect(quiet).toHaveBeenCalledWith(
      expect.stringContaining('session.title_changed not published'),
      expect.any(Error)
    )
    quiet.mockRestore()
  })
  it('a key naming no window, or no key at all, is not sent to', () => {
    const { sent } = windows()
    sessionTitleChanged('s1', 'fix auth', 'gone')
    sessionTitleChanged('s1', 'fix auth', null)
    expect(sent).toEqual([])
  })
  it('with no port installed nothing is sent and nothing throws', () => {
    installSessionWindows(null)
    expect(() => sessionTitleChanged('s1', 'fix auth', 'w1')).not.toThrow()
  })
})

// ── The mobile wave, lane B: what the notifier learns from where the sessions live ──
import { EventEmitter } from 'node:events'
import type { NotifySignals } from '@clave/server'
import { SessionManager } from '../sessions/session-manager'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec
} from '../sessions/adapter'
import {
  markDeliberateExit,
  notifyRequestAnswered,
  observeSessionsForNotify,
  stopNotifyObservation
} from './session-events'

/** An adapter the test drives: frames and exits emitted by hand. */
class DrivenAdapter implements SessionAdapter {
  readonly id = 'driven'
  readonly provider = 'driven'
  readonly transports = ['events'] as const
  readonly emitters = new Map<string, EventEmitter>()
  /** The code `kill` ends a session with. */
  exitCode = 0
  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    this.emitters.set(spec.id, new EventEmitter())
    return { id: spec.id }
  }
  async attach(id: string): Promise<SessionHandle> {
    return { id }
  }
  write(): void {
    // A driven session takes nothing: the test emits what it needs.
  }
  kill(handle: SessionHandle): void {
    this.emitters.get(handle.id)?.emit('exit', this.exitCode)
  }
  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): () => void {
    const emitter = this.emitters.get(handle.id)!
    const listener = callback as (...args: unknown[]) => void
    emitter.on(event, listener)
    return () => emitter.off(event, listener)
  }
  emit(id: string, event: string, value: unknown): void {
    this.emitters.get(id)!.emit(event, value)
  }
}

const spec = (id: string): SpawnSpec => ({
  id,
  provider: 'driven',
  transport: 'events',
  cwd: '/work',
  windowKey: 'w1',
  state: 'idle',
  createdAt: 1,
  adapterId: 'driven',
  title: id
})

const recorder = (): { signals: NotifySignals; seen: unknown[] } => {
  const seen: unknown[] = []
  return {
    seen,
    signals: {
      streamEvent: (sessionId, event) => seen.push(['frame', sessionId, event.type]),
      exited: (sessionId, code, deliberate) => seen.push(['exit', sessionId, code, deliberate]),
      requestAnswered: (sessionId, id) => seen.push(['answered', sessionId, id])
    }
  }
}

describe('the notifier hears the sessions’ frames and exits', () => {
  afterEach(() => stopNotifyObservation())

  it('forwards every frame of a stream and an exit with its code, for sessions before and after it started', async () => {
    const manager = new SessionManager()
    const adapter = new DrivenAdapter()
    manager.registerAdapter(adapter)
    await manager.create(spec('before'))
    const { signals, seen } = recorder()
    observeSessionsForNotify(manager, signals)
    await manager.create(spec('after'))
    adapter.emit('before', 'stream', {
      kind: 'event',
      event: { type: 'assistant_text', delta: 'x', final: true }
    })
    adapter.emit('after', 'stream', {
      kind: 'event',
      event: { type: 'permission_request', id: 'p', description: 'Allow?', options: [] }
    })
    adapter.exitCode = 1
    manager.kill('before')
    adapter.exitCode = 0
    manager.kill('after')
    expect(seen).toEqual([
      ['frame', 'before', 'assistant_text'],
      ['frame', 'after', 'permission_request'],
      ['frame', 'before', 'state_change'],
      ['exit', 'before', 1, false],
      ['frame', 'after', 'state_change'],
      ['exit', 'after', 0, false]
    ])
  })
  it('says an exit a stop or a restart asked for is deliberate, once', async () => {
    const manager = new SessionManager()
    const adapter = new DrivenAdapter()
    manager.registerAdapter(adapter)
    await manager.create(spec('s'))
    const { signals, seen } = recorder()
    observeSessionsForNotify(manager, signals)
    markDeliberateExit('s')
    adapter.exitCode = 143
    manager.kill('s')
    // The same tab back under the same id (a restart): its next exit is not deliberate.
    manager.forget('s')
    await manager.create(spec('s'))
    adapter.exitCode = 1
    manager.kill('s')
    expect(seen.filter((e) => (e as unknown[])[0] === 'exit')).toEqual([
      ['exit', 's', 143, true],
      ['exit', 's', 1, false]
    ])
  })
  it('forwards an answered request while observing, and nothing once stopped', async () => {
    const manager = new SessionManager()
    const adapter = new DrivenAdapter()
    manager.registerAdapter(adapter)
    await manager.create(spec('s'))
    const { signals, seen } = recorder()
    const stop = observeSessionsForNotify(manager, signals)
    notifyRequestAnswered('s', 'native-1')
    stop()
    notifyRequestAnswered('s', 'native-2')
    adapter.exitCode = 1
    manager.kill('s')
    expect(seen).toEqual([['answered', 's', 'native-1']])
  })
  it('stopNotifyObservation ends the observation in force, the way a quit does', async () => {
    const manager = new SessionManager()
    const adapter = new DrivenAdapter()
    manager.registerAdapter(adapter)
    await manager.create(spec('s'))
    const { signals, seen } = recorder()
    observeSessionsForNotify(manager, signals)
    stopNotifyObservation()
    adapter.exitCode = 1
    manager.kill('s')
    expect(seen).toEqual([])
  })
})
