/**
 * The digit shortcuts count what the sidebar draws (PRDCT-4123): a wave or
 * lane entry is one row, counted where its anchor sits, and a digit on it goes
 * to the session that holds it, never to the earlier member whose row it
 * took. A unit nobody holds answers its anchor, as a click on it does.
 * The store reads localStorage and the preload bridge at import time, so both
 * are stubbed first, as subagent-presentation.fixtures.test.ts does.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { deriveWorkUnits, type WorkAssignment } from '@clave/contract/work-rules'
import type { Session, SessionGroup } from './session-types'

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  cwd: '/fixture',
  folderName: 'fixture',
  name: id,
  alive: true,
  activityStatus: 'idle',
  promptWaiting: null,
  claudeMode: false,
  antigravityMode: false,
  codexMode: true,
  dangerousMode: false,
  claudeSessionId: null,
  sessionType: 'local',
  detectedUrl: null,
  serverStatus: null,
  serverCommand: null,
  hasUnseenActivity: false,
  userRenamed: true,
  planFilePath: null,
  workspaceId: 'fixture-workspace',
  ...over
})

const lane = (over: Partial<WorkAssignment> = {}): WorkAssignment => ({
  unit: 'lane-a',
  kind: 'lane',
  label: 'Pair the phone',
  role: 'lead',
  standing: 'current',
  joinedAt: 10,
  since: 10,
  ...over
})

let shortcutOrder: typeof import('./session-store').getVisibleFlatOrder
beforeAll(async () => {
  const mem = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => mem.set(k, v),
      removeItem: (k: string) => mem.delete(k)
    },
    window: { electronAPI: { captureTabClosed: () => {} } }
  })
  shortcutOrder = (await import('./session-store')).getVisibleFlatOrder
})

describe('digit shortcuts over a wave or lane entry', () => {
  it('count the entry once, at the place of the row it took, and go to its holder', () => {
    // A led the lane and was superseded by B; the entry sits where A sits.
    const a = session('A', { work: lane({ standing: 'superseded', joinedAt: 10, since: 30 }) })
    const b = session('B', { work: lane({ joinedAt: 20, since: 30 }) })
    const c = session('C')
    const state = {
      sessions: [a, b, c],
      groups: [] as SessionGroup[],
      displayOrder: ['A', 'C', 'B']
    }
    expect(shortcutOrder(state, 'fixture-workspace')).toEqual(['B', 'C'])
  })

  it('answer the anchor of a unit whose owner is unresolved', () => {
    // Only a successor that never accepted, and a verifier: nobody holds it.
    const d = session('D', {
      work: lane({ unit: 'lane-b', label: 'History', standing: 'pending', joinedAt: 10 })
    })
    const e = session('E', {
      work: lane({ unit: 'lane-b', label: 'History', role: 'verifier', joinedAt: 20 })
    })
    const c = session('C')
    expect(deriveWorkUnits([d, e]).map((u) => u.owner.state)).toEqual(['unresolved'])
    const state = {
      sessions: [d, e, c],
      groups: [] as SessionGroup[],
      displayOrder: ['E', 'C', 'D']
    }
    expect(shortcutOrder(state, 'fixture-workspace')).toEqual(['C', 'D'])
  })
})
