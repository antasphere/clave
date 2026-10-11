import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { ActivityRecorder, type RecorderSource } from './recorder'
import type { AgentState, Session } from '../../shared/session-model'

function fakeSource(): RecorderSource & {
  add(session: Session, model?: string | null): void
  state(id: string, state: AgentState): void
  remove(id: string): void
} {
  const added = new Set<(s: Session, m: { model: string | null }) => void>()
  const states = new Set<(id: string, s: AgentState) => void>()
  const removed = new Set<(id: string) => void>()
  const records = new Map<string, Session>()
  return {
    subscribeAdded: (cb) => (added.add(cb), () => added.delete(cb)),
    subscribeState: (cb) => (states.add(cb), () => states.delete(cb)),
    subscribeRemoved: (cb) => (removed.add(cb), () => removed.delete(cb)),
    get: (id) => records.get(id),
    add(session, model = null) {
      records.set(session.id, session)
      for (const cb of added) cb(session, { model })
    },
    state(id, state) {
      for (const cb of states) cb(id, state)
    },
    remove(id) {
      for (const cb of removed) cb(id)
      records.delete(id)
    }
  }
}

const session = (id: string): Session => ({
  id,
  provider: 'claude',
  transport: 'pty',
  cwd: '/w',
  windowKey: 'k',
  state: 'idle',
  createdAt: 0,
  adapterId: 'pty',
  title: `tab ${id}`
})

describe('ActivityRecorder', () => {
  let dir: string
  let clock: number
  const now = (): number => clock
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'clave-activity-'))
    clock = Date.parse('2026-10-11T08:00:00.000Z')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const lines = (): Record<string, unknown>[] =>
    readFileSync(path.join(dir, 'activity.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))

  it('writes start, open, state, close rows from the manager and a quit at quit', () => {
    const src = fakeSource()
    const rec = new ActivityRecorder(dir, { now, aliveMs: 1_000_000 })
    rec.start(src)
    clock += 1000
    src.add(session('a'), 'opus')
    clock += 1000
    src.state('a', 'working')
    clock += 1000
    src.remove('a')
    clock += 1000
    rec.quit()
    // The forgets the shutdown produces after the quit row never land.
    src.add(session('b'))
    src.remove('b')
    const rows = lines()
    expect(rows.map((r) => r.kind)).toEqual(['app', 'open', 'state', 'close', 'app'])
    expect(rows[1]).toMatchObject({
      id: 'a',
      provider: 'claude',
      cwd: '/w',
      name: 'tab a',
      model: 'opus'
    })
    expect(rows[2]).toMatchObject({ id: 'a', state: 'working' })
    expect(rows[3]).toMatchObject({ id: 'a', name: 'tab a' })
    expect(rows[4]).toMatchObject({ app: 'quit' })
    expect(rows[4].synthetic).toBeUndefined()
    expect(rec.all()).toHaveLength(5)
  })

  it('a run that never quit gets a synthetic quit at the alive stamp on the next boot', () => {
    const src = fakeSource()
    const first = new ActivityRecorder(dir, { now, aliveMs: 1_000_000 })
    first.start(src)
    clock += 60_000
    src.add(session('a'))
    src.state('a', 'working')
    clock += 25 * 60_000
    // The alive stamp lands later than the last row, as it does while an agent works.
    writeFileSync(
      path.join(dir, 'alive.json'),
      JSON.stringify({ ts: new Date(clock).toISOString() })
    )
    first.stop()
    clock += 3 * 3_600_000
    const second = new ActivityRecorder(dir, { now, aliveMs: 1_000_000 })
    second.start(fakeSource())
    const rows = lines()
    const quit = rows.find((r) => r.kind === 'app' && r.app === 'quit')!
    expect(quit.synthetic).toBe(true)
    expect(quit.ts).toBe(new Date(clock - 3 * 3_600_000).toISOString())
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'app', app: 'start' })
    second.stop()
  })

  it('a run that quit cleanly gets no synthetic quit, and an empty file none either', () => {
    const fresh = new ActivityRecorder(dir, { now, aliveMs: 1_000_000 })
    fresh.start(fakeSource())
    expect(lines().map((r) => r.kind)).toEqual(['app'])
    fresh.quit()
    const again = new ActivityRecorder(dir, { now, aliveMs: 1_000_000 })
    again.start(fakeSource())
    expect(lines().map((r) => `${r.kind}:${r.app}`)).toEqual(['app:start', 'app:quit', 'app:start'])
    again.stop()
  })

  it('a malformed line is skipped on load, and the alive stamp is written on start', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'activity.jsonl'), 'not json\n{"kind":"app","ts":"x"}\n')
    const rec = new ActivityRecorder(dir, { now, aliveMs: 1_000_000 })
    rec.start(fakeSource())
    expect(rec.all()).toHaveLength(1)
    expect(JSON.parse(readFileSync(path.join(dir, 'alive.json'), 'utf-8')).ts).toBe(
      new Date(clock).toISOString()
    )
    rec.stop()
  })
})
