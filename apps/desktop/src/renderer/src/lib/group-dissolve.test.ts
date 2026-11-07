import { describe, expect, it } from 'vitest'
import {
  dissolveConfirmation,
  runningTerminalSessions,
  sessionsToKillOnDissolve
} from './group-dissolve-rules'

const terminal = (
  id: string,
  sessionId: string | null
): {
  id: string
  command: string
  commandMode: 'auto'
  color: 'green'
  sessionId: string | null
} => ({
  id,
  command: 'npm run dev',
  commandMode: 'auto' as const,
  color: 'green' as const,
  sessionId
})

const group = {
  id: 'g1',
  sessionIds: ['agent-a', 'agent-b'],
  terminals: [terminal('t-dev', 'dev'), terminal('t-board', 'board'), terminal('t-idle', null)]
}

const sessions = [
  { id: 'agent-a', alive: true },
  { id: 'agent-b', alive: true },
  { id: 'dev', alive: true },
  { id: 'board', alive: false }
]

describe('sessionsToKillOnDissolve — a terminal belongs to its group', () => {
  it('Delete kills the members AND every terminal session, running or not', () => {
    expect(sessionsToKillOnDissolve(group, 'delete').sort()).toEqual(
      ['agent-a', 'agent-b', 'board', 'dev'].sort()
    )
  })

  it('Ungroup keeps the members (they become tabs) and kills only the terminals', () => {
    expect(sessionsToKillOnDissolve(group, 'ungroup').sort()).toEqual(['board', 'dev'])
  })

  it('a terminal that never launched contributes nothing to kill', () => {
    expect(
      sessionsToKillOnDissolve(
        { id: 'g', sessionIds: [], terminals: [terminal('t', null)] },
        'delete'
      )
    ).toEqual([])
  })

  it('a member linked as a terminal is killed once', () => {
    const g = { id: 'g', sessionIds: ['x'], terminals: [terminal('t', 'x')] }
    expect(sessionsToKillOnDissolve(g, 'delete')).toEqual(['x'])
  })
})

describe('runningTerminalSessions', () => {
  it('counts only terminal sessions that exist and are alive', () => {
    expect(runningTerminalSessions(group, sessions)).toEqual(['dev'])
  })

  it('a terminal whose session left the store is not running', () => {
    expect(runningTerminalSessions(group, [{ id: 'agent-a', alive: true }])).toEqual([])
  })
})

describe('dissolveConfirmation — ask only when a running terminal would stop', () => {
  it('no running terminal: no question, the action is immediate as before', () => {
    const quiet = { id: 'g', sessionIds: ['a'], terminals: [terminal('t', 'board')] }
    expect(dissolveConfirmation(quiet, sessions, 'delete')).toBeNull()
    expect(dissolveConfirmation(quiet, sessions, 'ungroup')).toBeNull()
  })

  it('Delete with a running terminal says it stops it', () => {
    const c = dissolveConfirmation(group, sessions, 'delete')
    expect(c?.title).toBe('Delete group')
    expect(c?.confirmLabel).toBe('Delete')
    expect(c?.message).toContain('1 running terminal')
    expect(c?.message).toMatch(/stops/)
  })

  it('Ungroup with running terminals says the sessions stay and the terminals stop', () => {
    const two = [...sessions.filter((s) => s.id !== 'board'), { id: 'board', alive: true }]
    const c = dissolveConfirmation(group, two, 'ungroup')
    expect(c?.title).toBe('Ungroup')
    expect(c?.confirmLabel).toBe('Ungroup')
    expect(c?.message).toContain('2 running terminals')
    expect(c?.message).toMatch(/keeps its sessions as tabs/)
    expect(c?.message).toMatch(/stops those terminals/)
  })
})
