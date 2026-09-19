import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { append } = vi.hoisted(() => ({ append: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/clave-session-capture-test' } }))
vi.mock('../exchange-capture/store', () => ({
  CaptureStore: class {
    append = append
  }
}))
vi.mock('./adapters/pty-backend', () => ({
  ptyBackend: { getSession: () => ({ claudeSessionId: 'conversation' }) }
}))
import { sessionManager } from './session-manager'
import { EchoAdapter } from './adapters/echo-adapter'
import { captureSessionState } from '../exchange-capture/service'
import type { SessionState } from '../exchange-capture/types'

let n = 0
function fixture(): string {
  const id = `capture-${++n}`
  const adapter = new EchoAdapter()
  const session = {
    id,
    provider: 'claude',
    transport: 'events' as const,
    cwd: '/project',
    windowKey: 'window',
    state: 'idle' as const,
    createdAt: Date.now(),
    adapterId: 'echo',
    title: 'Agent'
  }
  sessionManager.adopt(session, adapter.prepare(session), adapter)
  return id
}
function report(id: string, state: SessionState, groupName: string): void {
  captureSessionState({
    ts: new Date().toISOString(),
    session: {
      sessionId: id,
      name: 'Renamed',
      mode: 'claude',
      cwd: '/project',
      claudeSessionId: 'conversation',
      groupId: groupName,
      groupName
    },
    state,
    previous: null,
    source: state === 'exited' ? 'pty' : 'hooks'
  })
}

describe('exchange capture consumes session state streams', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    append.mockClear()
  })
  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })
  it('records manager transitions without renderer messages using a bounded fallback', () => {
    const id = fixture()
    sessionManager.setState(id, 'working')
    sessionManager.setState(id, 'done')
    sessionManager.setState(id, 'idle')
    expect(append).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(append.mock.calls.map(([e]) => [e.state, e.previous])).toEqual([
      ['working', null],
      ['idle', 'working']
    ])
    expect(append.mock.calls[0][0].session.claudeSessionId).toBe('conversation')
    sessionManager.forget(id)
  })
  it('uses each transition’s current group identity and never replays delayed renderer states', () => {
    const id = fixture()
    sessionManager.setState(id, 'working')
    sessionManager.setState(id, 'blocked')
    report(id, 'working', 'First group')
    expect(sessionManager.get(id)?.state).toBe('blocked')
    report(id, 'blocked', 'Moved group')
    expect(append.mock.calls.map(([e]) => [e.state, e.previous, e.session.groupName])).toEqual([
      ['working', null, 'First group'],
      ['blocked', 'working', 'Moved group']
    ])
    sessionManager.setState(id, 'done')
    report(id, 'idle', 'Moved group')
    expect(sessionManager.get(id)?.state).toBe('done')
    report(id, 'working', 'Late report')
    expect(sessionManager.get(id)?.state).toBe('done')
    expect(append).toHaveBeenCalledTimes(3)
    sessionManager.kill(id)
    sessionManager.forget(id)
    report(id, 'exited', 'Moved group')
    report(id, 'exited', 'Moved group')
    expect(append).toHaveBeenCalledTimes(4)
    expect(append.mock.calls.at(-1)?.[0]).toMatchObject({
      state: 'exited',
      source: 'pty',
      previous: 'idle'
    })
  })
  it('retains manager order when renderer reports arrive out of order', () => {
    const id = fixture()
    sessionManager.setState(id, 'working')
    sessionManager.setState(id, 'blocked')
    report(id, 'blocked', 'Group')
    expect(append).not.toHaveBeenCalled()
    report(id, 'working', 'Group')
    expect(append.mock.calls.map(([e]) => e.state)).toEqual(['working', 'blocked'])
    vi.runAllTimers()
    expect(append).toHaveBeenCalledTimes(2)
    sessionManager.forget(id)
  })
})
