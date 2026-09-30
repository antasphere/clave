import { describe, it, expect } from 'vitest'
import { finishesTurn, tabIndicators } from './tab-status'

type Fields = Parameters<typeof tabIndicators>[0]

const claude: Fields = {
  alive: true,
  sessionType: 'local',
  claudeMode: true,
  claudeAgentsMode: false,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  hasUnseenActivity: false,
  injectedFrom: null
}
const codex: Fields = { ...claude, claudeMode: false, codexMode: true }
const pi: Fields = { ...claude, claudeMode: false, piMode: true }
const terminal: Fields = { ...claude, claudeMode: false }
const antigravity: Fields = { ...claude, claudeMode: false, antigravityMode: true }

describe('tabIndicators', () => {
  it.each([
    ['a fresh Claude tab', claude, 'idle'],
    ['a working Claude tab', { ...claude, agentState: 'working' }, 'working'],
    ['a Claude tab waiting on a permission', { ...claude, agentState: 'blocked' }, 'needs-you'],
    ['a Claude tab done and seen', { ...claude, agentState: 'done' }, 'idle'],
    [
      'a Claude tab done while away',
      { ...claude, agentState: 'done', hasUnseenActivity: true },
      'unread'
    ],
    ['a dead Claude tab', { ...claude, alive: false, agentState: 'working' }, 'ended'],
    ['a working Codex tab', { ...codex, agentState: 'working' }, 'working'],
    ['a Codex tab needing action', { ...codex, agentState: 'blocked' }, 'needs-you'],
    ['a Pi tab never blocks', { ...pi, agentState: 'blocked' }, 'idle'],
    ['a terminal ignores a stray state', { ...terminal, agentState: 'working' }, 'idle'],
    ['a terminal ignores output noise', { ...terminal, hasUnseenActivity: true }, 'idle'],
    ['a terminal written to by another tab', { ...terminal, injectedFrom: 'Wave' }, 'unread'],
    ['an Antigravity tab stays neutral', { ...antigravity, agentState: 'blocked' }, 'idle'],
    [
      'a remote Claude tab stays neutral',
      { ...claude, sessionType: 'remote', agentState: 'working' },
      'idle'
    ]
  ] as const)('%s → %s', (_label, session, status) => {
    expect(tabIndicators(session as Fields).status).toBe(status)
  })

  it('ranks needs-you over working over unread', () => {
    expect(tabIndicators({ ...claude, agentState: 'blocked', injectedFrom: 'Wave' }).status).toBe(
      'needs-you'
    )
    expect(
      tabIndicators({ ...claude, agentState: 'working', hasUnseenActivity: true }).status
    ).toBe('working')
  })

  it('never lets background work colour the logo', () => {
    const done = tabIndicators({ ...claude, agentState: 'done', backgroundTasks: 2 })
    expect(done).toEqual({ status: 'idle', background: 2 })
  })

  it('counts nothing in the background of a dead or neutral tab', () => {
    expect(tabIndicators({ ...claude, alive: false, backgroundTasks: 2 }).background).toBe(0)
    expect(tabIndicators({ ...terminal, backgroundTasks: 2 }).background).toBe(0)
  })
})

describe('finishesTurn', () => {
  it.each([
    ['working', 'done', true],
    ['working', 'idle', true],
    ['blocked', 'done', true],
    [undefined, 'done', false],
    ['idle', 'done', false],
    ['done', 'idle', false],
    ['working', 'blocked', false]
  ] as const)('%s → %s: %s', (previous, next, expected) => {
    expect(finishesTurn(previous, next)).toBe(expected)
  })
})
