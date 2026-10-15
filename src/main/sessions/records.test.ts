import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  kill: vi.fn(),
  setSessionWindowKey: vi.fn(),
  getSessionRecord: vi.fn(),
  listAdoptableSessions: vi.fn((): unknown[] => []),
  getAllSessions: vi.fn((): { id: string }[] => []),
  discardSessionRecord: vi.fn(),
  unbind: vi.fn(),
  kernelGet: vi.fn(),
  kernelStarted: vi.fn()
}))
vi.mock('./session-manager', () => ({
  sessionManager: { get: mocks.kernelGet, started: mocks.kernelStarted }
}))
vi.mock('../pty-manager', () => ({
  ptyManager: {
    getSession: mocks.getSession,
    kill: mocks.kill,
    setSessionWindowKey: mocks.setSessionWindowKey,
    getSessionRecord: mocks.getSessionRecord,
    listAdoptableSessions: mocks.listAdoptableSessions,
    getAllSessions: mocks.getAllSessions,
    discardSessionRecord: mocks.discardSessionRecord
  }
}))
vi.mock('./windows', () => ({ sessionWindows: () => ({ unbind: mocks.unbind }) }))
// recordsForIds is pure; use the real one.
import { sessionRecords } from './records'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listAdoptableSessions.mockReturnValue([] as unknown[])
  mocks.getAllSessions.mockReturnValue([])
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

  // Issue #183: the backend's listing knows only its own PTYs, so a chat the
  // host already holds came back as a record to spawn: the window's spawn
  // failed on the duplicate id and the tab left the sidebar.
  describe('a chat session the host already holds', () => {
    const chat = (id: string): Record<string, unknown> => ({
      id,
      cwd: '/c',
      folderName: 'c',
      transport: 'events',
      live: false
    })
    beforeEach(() => {
      mocks.listAdoptableSessions.mockReturnValue([chat('dormant'), chat('started'), chat('cold')])
      const hosted = new Set(['dormant', 'started'])
      // Registered in the kernel and in the manager's event sessions alike;
      // `alive` there is membership, never whether the provider runs.
      mocks.getSession.mockImplementation((id) => (hosted.has(id) ? { alive: true } : undefined))
      mocks.kernelGet.mockImplementation((id) =>
        hosted.has(id) ? { id, transport: 'events' } : undefined
      )
      mocks.kernelStarted.mockImplementation((id) => id === 'started')
      mocks.getSessionRecord.mockImplementation((id) => chat(id))
      mocks.getAllSessions.mockReturnValue([...hosted].map((id) => ({ id })))
    })

    it('is listed as running, live only when its provider was started', () => {
      const out = sessionRecords.listAdoptableRecords()
      expect(out.map((r) => [r.id, r.running, r.live])).toEqual([
        ['dormant', true, false],
        ['started', true, true],
        ['cold', undefined, false]
      ])
    })

    it('is answered by id the same way', () => {
      const out = sessionRecords.listAdoptableRecords(['dormant', 'started', 'cold'])
      expect(out.map((r) => [r.id, r.running, r.live])).toEqual([
        ['dormant', true, false],
        ['started', true, true],
        ['cold', undefined, false]
      ])
    })
  })

  it('lists a live terminal tab the host runs, which the backend leaves out, as running', () => {
    mocks.getAllSessions.mockReturnValue([{ id: 'term' }, { id: 'dead' }])
    mocks.getSession.mockImplementation((id) =>
      id === 'term' ? { alive: true } : id === 'dead' ? { alive: false } : undefined
    )
    mocks.getSessionRecord.mockImplementation((id) => ({ id, cwd: '/t', folderName: 't' }))
    const out = sessionRecords.listAdoptableRecords()
    expect(out.map((r) => [r.id, r.running, r.live])).toEqual([['term', true, true]])
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
