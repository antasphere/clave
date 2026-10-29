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
  it('the stamp first', () => {
    expect(workspaceOfSession(base, 'other', workspaces)).toBe('other')
  })
  it('then the deepest root holding the folder', () => {
    expect(workspaceOfSession(base, undefined, workspaces)).toBe('project')
    expect(workspaceOfSession({ cwd: '/home/v/notes' }, undefined, workspaces)).toBe('home')
    expect(workspaceOfSession({ cwd: '/home/v/projectile' }, undefined, workspaces)).toBe('home')
  })
  it('else every workspace', () => {
    expect(workspaceOfSession({ cwd: '/tmp/elsewhere' }, undefined, workspaces)).toBeNull()
    expect(workspaceOfSession(base, 'gone-workspace', [{ id: 'x', rootDir: '/x' }])).toBeNull()
  })
  it("filters a workspace's sessions by that rule", () => {
    const sessions: Session[] = [
      { ...base, id: 'a', cwd: '/home/v/project' },
      { ...base, id: 'b', cwd: '/tmp/elsewhere' },
      { ...base, id: 'c', cwd: '/srv/other/x' }
    ]
    const stamps = new Map<string, string | undefined>([['c', 'home']])
    expect(sessionsOfWorkspace(sessions, stamps, workspaces, 'project').map((s) => s.id)).toEqual([
      'a',
      'b'
    ])
    expect(sessionsOfWorkspace(sessions, stamps, workspaces, 'home').map((s) => s.id)).toEqual([
      'b',
      'c'
    ])
    expect(sessionsOfWorkspace(sessions, stamps, workspaces, 'other').map((s) => s.id)).toEqual([
      'b'
    ])
  })
})
