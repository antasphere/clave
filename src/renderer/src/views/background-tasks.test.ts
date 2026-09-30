import { expect, it } from 'vitest'
import { latestBackgroundTasks } from './background-tasks'
import type { SessionLog } from './conversation-store'

const task = { id: 'b1', kind: 'shell' as const, description: 'Watch the build', startedAt: 1 }

it('reads the snapshot the log kept, never scanning the events', () => {
  // No events at all: the answer comes from the kept snapshot alone.
  const log: SessionLog = { events: [], past: [], ready: true, background: [task] }
  expect(latestBackgroundTasks(log)).toEqual([task])
})

it('reports nothing for an empty snapshot, an exited provider, or no log', () => {
  expect(latestBackgroundTasks({ events: [], past: [], ready: true, background: [] })).toEqual([])
  expect(
    latestBackgroundTasks({ events: [], past: [], ready: true, background: [task], exitCode: 0 })
  ).toEqual([])
  expect(latestBackgroundTasks(undefined)).toEqual([])
})
