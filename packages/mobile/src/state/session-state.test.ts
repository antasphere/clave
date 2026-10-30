import { describe, expect, it } from 'vitest'
import type { Session } from '../contract/types'
import {
  orderSessions,
  phoneSessionState,
  sessionsOfWorkspace,
  workspaceOfSession
} from './session-state'

const base: Session = {
  id: 's',
  provider: 'claude',
  transport: 'events',
  cwd: '/home/v/project',
  windowKey: 'server',
  state: 'idle',
  createdAt: 1,
  adapterId: 'claude-chat',
  title: 't'
}

describe('the state mapping', () => {
  it('maps the five server states and the fatal error', () => {
    expect(phoneSessionState('working')).toBe('working')
    expect(phoneSessionState('blocked')).toBe('waiting')
    expect(phoneSessionState('idle')).toBe('idle')
    expect(phoneSessionState('done')).toBe('finished')
    expect(phoneSessionState('ended')).toBe('finished')
    expect(phoneSessionState('working', 'limit reached')).toBe('error')
    expect(phoneSessionState('ended', null)).toBe('finished')
  })
  it('lists chats first, newest first, terminals after', () => {
    const ordered = orderSessions([
      { ...base, id: 'term-new', transport: 'pty', createdAt: 9 },
      { ...base, id: 'chat-old', createdAt: 1 },
      { ...base, id: 'chat-new', createdAt: 5 }
    ])
    expect(ordered.map((s) => s.id)).toEqual(['chat-new', 'chat-old', 'term-new'])
  })
})

describe('which workspace a session shows under', () => {
  const workspaces = [
    { id: 'home', rootDir: '/home/v' },
    { id: 'project', rootDir: '/home/v/project' },
    { id: 'other', rootDir: '/srv/other' }
  ]
  it('uses an explicit stamp even when its workspace is missing or deleted', () => {
    expect(workspaceOfSession(base, 'other', workspaces)).toBe('other')
    expect(workspaceOfSession(base, 'gone-workspace', [])).toBe('gone-workspace')
  })
  it('keeps an absent stamp unknown for compatibility with older servers', () => {
    expect(workspaceOfSession(base, undefined, workspaces)).toBeNull()
  })
  it('filters only by the stamp, never by a contradictory or nested cwd', () => {
    const sessions: Session[] = [
      { ...base, id: 'a', cwd: '/home/v/project' },
      { ...base, id: 'b', cwd: '/home/v/project/nested' },
      { ...base, id: 'c', cwd: '/srv/other/x' },
      { ...base, id: 'deleted', cwd: '/home/v/project' }
    ]
    const stamps = new Map<string, string | undefined>([
      ['a', 'other'],
      ['c', 'home'],
      ['deleted', 'gone-workspace']
    ])
    expect(sessionsOfWorkspace(sessions, stamps, workspaces, 'project').map((s) => s.id)).toEqual([
      'b'
    ])
    expect(sessionsOfWorkspace(sessions, stamps, workspaces, 'home').map((s) => s.id)).toEqual([
      'b',
      'c'
    ])
    expect(sessionsOfWorkspace(sessions, stamps, workspaces, 'other').map((s) => s.id)).toEqual([
      'a',
      'b'
    ])
    expect(
      sessionsOfWorkspace(sessions, stamps, workspaces, 'gone-workspace').map((s) => s.id)
    ).toEqual(['b', 'deleted'])
  })
})
