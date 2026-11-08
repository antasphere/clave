import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../../../shared/session-model'
import { endIsCurrent } from './session-end'

const record = (id: string, state: Session['state']): Session => ({
  id,
  title: 'Fixture',
  cwd: '/tmp',
  transport: 'events',
  windowKey: 'main',
  adapterId: 'claude-chat',
  provider: 'claude',
  state,
  createdAt: 1
})
const list = (records: Session[]) => () => Promise.resolve(records)

describe('endIsCurrent', () => {
  it('takes an end the record confirms', async () => {
    expect(await endIsCurrent('s', list([record('s', 'ended')]))).toBe(true)
  })
  it('takes an end for a session main no longer holds', async () => {
    expect(await endIsCurrent('s', list([record('other', 'idle')]))).toBe(true)
  })
  it('drops the end of a process a live session under the same id replaced', async () => {
    // A tab moved to another account: the old process's end arrives after
    // the new process is on record.
    for (const state of ['idle', 'working', 'blocked'] as const)
      expect(await endIsCurrent('s', list([record('s', state)]))).toBe(false)
  })
})

describe('an end heard for a tab on a Clave server (PRDCT-4191, round 3 C1)', () => {
  // The window's list of a server is the snapshot it last took, stale after
  // a restart: the server is asked now, and only its word decides.
  const key = 'clave-owner:session:srv:abc'
  it('asks the server, not the stale list', async () => {
    const list = vi.fn(async () => [{ id: key, state: 'working' }] as never)
    const server = vi.fn(async (serverId: string) => {
      expect(serverId).toBe('srv')
      return [{ id: key, state: 'ended' as const }]
    })
    expect(await endIsCurrent(key, list, server)).toBe(true)
    expect(list).not.toHaveBeenCalled()
  })
  it('drops the end when the server runs the chat, whatever the list said', async () => {
    const server = async (): Promise<{ id: string; state: 'idle' }[]> => [
      { id: key, state: 'idle' }
    ]
    expect(await endIsCurrent(key, async () => [], server)).toBe(false)
  })
  it('takes the end when the server cannot be asked, whatever the stale list says', async () => {
    // A daemon stopping answers nothing: it is not running the chat for this
    // window, and a daemon back running it says so at the next bind.
    const list = vi.fn(async () => [{ id: key, state: 'working' }] as never)
    const server = async (): Promise<never> => {
      throw new Error('did not answer')
    }
    expect(await endIsCurrent(key, list, server)).toBe(true)
    expect(list).not.toHaveBeenCalled()
  })
})
