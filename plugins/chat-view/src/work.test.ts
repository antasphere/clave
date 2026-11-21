import { describe, expect, it } from 'vitest'
import type { SubAgent } from './terminal-status'
import { LEAVE_MS, QUIET_MS, elapsed, isQuiet, nextLeaving, workFigures, workRows } from './work'

const T0 = 1_000_000

function agent(id: string, patch: Partial<SubAgent> = {}): SubAgent {
  return {
    id,
    taskId: `task-${id}`,
    kind: 'agent',
    fromAgentTool: true,
    requestedBackground: false,
    type: 'Explore',
    description: `Look into ${id}`,
    command: null,
    outputFile: null,
    background: true,
    startedAt: T0,
    lastAction: null,
    lastActiveAt: T0,
    toolCount: 0,
    contextUsed: null,
    model: null,
    ...patch
  }
}
const shell = (id: string): SubAgent =>
  agent(id, { kind: 'shell', type: 'shell', command: 'npm run serve', fromAgentTool: false })

describe('elapsed', () => {
  it('reads seconds, then minutes and seconds, then hours and minutes', () => {
    expect(elapsed(T0, T0 + 12_400)).toBe('12s')
    expect(elapsed(T0, T0 + 192_000)).toBe('3m 12s')
    expect(elapsed(T0, T0 + 3_840_000)).toBe('1h 4m')
  })
  it('never goes below zero', () => {
    expect(elapsed(T0, T0 - 5_000)).toBe('0s')
  })
})

describe('isQuiet', () => {
  it('an agent goes quiet a minute after its last sign of work', () => {
    expect(isQuiet(agent('a'), T0 + QUIET_MS - 1)).toBe(false)
    expect(isQuiet(agent('a'), T0 + QUIET_MS)).toBe(true)
  })
  it('a command is never quiet', () => {
    expect(isQuiet(shell('s'), T0 + QUIET_MS * 10)).toBe(false)
  })
})

describe('workFigures', () => {
  it("says an agent's figures in the card's order and words", () => {
    const f = workFigures(
      agent('a', {
        toolCount: 12,
        contextUsed: 48_000,
        model: 'claude-sonnet-5-5',
        lastActiveAt: T0 + 190_000
      }),
      T0 + 192_000
    )
    expect(f).toEqual({
      steps: '12 steps',
      context: '48k ctx',
      time: '3m 12s',
      ran: '3m 12s',
      quiet: false,
      model: 'Sonnet 5.5',
      modelTitle: 'Launched on Sonnet 5.5'
    })
  })
  it('one step is a step; no step and no context say nothing', () => {
    expect(workFigures(agent('a', { toolCount: 1 }), T0).steps).toBe('1 step')
    expect(workFigures(agent('a'), T0).steps).toBeNull()
    expect(workFigures(agent('a'), T0).context).toBeNull()
  })
  it('a quiet agent says how long it has been quiet in the place of the time', () => {
    const f = workFigures(agent('a', { lastActiveAt: T0 }), T0 + 130_000)
    expect(f.quiet).toBe(true)
    expect(f.time).toBe('quiet 2m 10s')
    expect(f.ran).toBe('2m 10s')
  })
  it('a model not named yet reads "…", and its title says when it will be', () => {
    const f = workFigures(agent('a'), T0)
    expect(f.model).toBe('…')
    expect(f.modelTitle).toBe('Its model is named at its first answer')
  })
  it('a command has its time alone', () => {
    const f = workFigures(shell('s'), T0 + 5_000)
    expect(f).toMatchObject({ steps: null, context: null, model: null, time: '5s' })
  })
})

describe('the leaving list', () => {
  it('a row the next list drops leaves; a row listed again stops leaving', () => {
    const a = agent('a')
    const b = agent('b')
    const leaving = nextLeaving([a, b], [a], [])
    expect(leaving.map((x) => x.id)).toEqual(['b'])
    expect(nextLeaving([a], [a, b], leaving)).toEqual([])
  })
  it('a row already leaving is not added twice', () => {
    const a = agent('a')
    expect(nextLeaving([a], [], [a]).map((x) => x.id)).toEqual(['a'])
  })
  it('the rows are the running ones in order, then the leaving ones', () => {
    const rows = workRows([agent('a'), shell('s')], [agent('b')])
    expect(rows.map((r) => [r.agent.id, r.gone])).toEqual([
      ['a', false],
      ['s', false],
      ['b', true]
    ])
  })
  it('the fold is held a little past twice the default duration', () => {
    expect(LEAVE_MS).toBeGreaterThan(300)
  })
})
