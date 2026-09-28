import { describe, expect, it } from 'vitest'
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
