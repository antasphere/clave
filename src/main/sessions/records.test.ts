import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  kill: vi.fn(),
  setSessionWindowKey: vi.fn(),
  getSessionRecord: vi.fn(),
  listAdoptableSessions: vi.fn((): unknown[] => []),
  discardSessionRecord: vi.fn(),
  unbind: vi.fn()
}))
vi.mock('../pty-manager', () => ({
  ptyManager: {
    getSession: mocks.getSession,
    kill: mocks.kill,
    setSessionWindowKey: mocks.setSessionWindowKey,
    getSessionRecord: mocks.getSessionRecord,
    listAdoptableSessions: mocks.listAdoptableSessions,
    discardSessionRecord: mocks.discardSessionRecord
  }
}))
vi.mock('./windows', () => ({ sessionWindows: () => ({ unbind: mocks.unbind }) }))
// recordsForIds is pure; use the real one.
import { sessionRecords } from './records'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listAdoptableSessions.mockReturnValue([] as unknown[])
})

describe('the host’s session records', () => {
  it('lists the adoptable records whole', () => {
    const all: unknown[] = [{ id: 'a', cwd: '/x', folderName: 'x' }]
    mocks.listAdoptableSessions.mockReturnValue(all)
    expect(sessionRecords.listAdoptableRecords()).toBe(all)
  })

  it('by ids, adds a running session this process already holds, marked running', () => {
    mocks.listAdoptableSessions.mockReturnValue([
      { id: 'adoptable', cwd: '/x', folderName: 'x' }
    ] as unknown[])
    mocks.getSessionRecord.mockImplementation((id) =>
      id === 'live' ? { id: 'live', cwd: '/y', folderName: 'y' } : undefined
    )
    mocks.getSession.mockImplementation((id) => (id === 'live' ? { alive: true } : undefined))
    const out = sessionRecords.listAdoptableRecords(['adoptable', 'live', 'ghost'])
    expect(out.map((r) => r.id).sort()).toEqual(['adoptable', 'live'])
    expect(out.find((r) => r.id === 'live')).toMatchObject({ running: true, live: true })
  })

  it('discards a record by key', () => {
    sessionRecords.discardRecord('clave-a')
    expect(mocks.discardSessionRecord).toHaveBeenCalledWith('clave-a')
  })

  it('releases a tmux-backed session: it is killed-detached and unbound, and reported released', () => {
    mocks.getSession.mockReturnValue({ tmuxName: 'clave-s1' })
    const outcome = sessionRecords.release(['s1'])
    expect(outcome).toEqual({ released: ['s1'], refused: [] })
    // Detach, not destroy: the tmux session and the record survive the move.
    expect(mocks.kill).toHaveBeenCalledWith('s1', false)
    expect(mocks.unbind).toHaveBeenCalledWith('s1')
    expect(mocks.setSessionWindowKey).not.toHaveBeenCalled()
  })

  it('refuses a session that is not running, and one on a plain pty', () => {
    mocks.getSession.mockImplementation((id) =>
      id === 'plain' ? { tmuxName: undefined } : undefined
    )
    const outcome = sessionRecords.release(['gone', 'plain'])
    expect(outcome.released).toEqual([])
    expect(outcome.refused).toEqual([
      { sessionId: 'gone', reason: 'not-live' },
      { sessionId: 'plain', reason: 'not-tmux' }
    ])
    // No fallback: a plain session is neither re-stamped nor detached.
    expect(mocks.setSessionWindowKey).not.toHaveBeenCalled()
    expect(mocks.kill).not.toHaveBeenCalled()
  })

  it('with a fallback window, re-stamps and detaches a plain session the way a close does', () => {
    mocks.getSession.mockReturnValue({ tmuxName: undefined })
    const outcome = sessionRecords.release(['plain'], 'primary-key')
    expect(outcome.refused).toEqual([{ sessionId: 'plain', reason: 'not-tmux' }])
    expect(mocks.setSessionWindowKey).toHaveBeenCalledWith('plain', 'primary-key')
    expect(mocks.kill).toHaveBeenCalledWith('plain', false)
    expect(mocks.unbind).toHaveBeenCalledWith('plain')
  })
})
