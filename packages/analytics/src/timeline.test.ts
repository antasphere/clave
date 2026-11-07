import { describe, expect, it } from 'vitest'
import type { Block, ViewRow } from './ledger'
import { emptyFigures } from './ledger'
import {
  STEPS_MS,
  blockRect,
  blockWords,
  formatClock,
  formatDay,
  formatDuration,
  laneRows,
  spanOf,
  spanOfAll,
  tickStep,
  timeScale,
  waitWords,
  waits
} from './timeline'

/** A local moment: the tests build dates with the local constructor so the ticks, which sit
 *  on local boundaries, read the same in every time zone. */
const local = (hour: number, minute = 0, day = 4): number =>
  new Date(2026, 10, day, hour, minute).getTime()
const iso = (t: number): string => new Date(t).toISOString()
const block = (start: number, end: number, messages = 1, toolCalls = 0): Block => ({
  start: iso(start),
  end: iso(end),
  minutes: (end - start) / 60_000,
  messages,
  toolCalls
})

describe('the span', () => {
  it('runs from the first start to the last end, whatever the order', () => {
    const list = [block(local(10), local(10, 30)), block(local(9), local(9, 20))]
    expect(spanOf(list)).toEqual({ start: local(9), end: local(10, 30) })
    expect(spanOf([])).toBeNull()
    expect(spanOfAll([[block(local(9), local(9, 5))], [], [block(local(8), local(12))]])).toEqual({
      start: local(8),
      end: local(12)
    })
    expect(spanOfAll([[], []])).toBeNull()
  })
})

describe('the tick step', () => {
  it('is the smallest step whose ticks stay at least the minimum apart', () => {
    // 10 minutes over 600 px: 1-minute ticks would sit 60 px apart, too close at 72; 2 minutes fit.
    expect(tickStep(10 * 60_000, 600)).toBe(2 * 60_000)
    // A whole working day over 800 px: 11 one-hour ticks would be 72 px apart, so one hour.
    expect(tickStep(10 * 3_600_000, 800)).toBe(3_600_000)
    // Three days over 600 px: 8 ticks at most, so 12 hours.
    expect(tickStep(3 * 86_400_000, 600)).toBe(12 * 3_600_000)
    // Nothing fits: the largest step.
    expect(tickStep(400 * 86_400_000, 100)).toBe(STEPS_MS[STEPS_MS.length - 1])
  })
})

describe('the time scale', () => {
  it('maps the span onto the width and puts its ticks on local boundaries', () => {
    const scale = timeScale({ start: local(9, 7), end: local(11, 52) }, 660)
    expect(scale.x(local(9, 7))).toBe(0)
    expect(scale.x(local(11, 52))).toBe(660)
    expect(scale.x(local(8))).toBe(0)
    expect(scale.x(local(13))).toBe(660)
    expect(scale.step).toBe(30 * 60_000)
    expect(scale.ticks.map((t) => t.label)).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30'])
    expect(scale.ticks.every((t) => !t.day)).toBe(true)
  })

  it('names the day on a midnight tick, and the days alone from a day up', () => {
    const night = timeScale({ start: local(22, 0, 3), end: local(2, 0, 4) }, 800)
    const midnight = night.ticks.find((t) => t.day)
    expect(midnight?.label).toBe('4 Nov')
    expect(midnight?.t).toBe(local(0, 0, 4))
    expect(night.step).toBe(30 * 60_000)
    expect(night.ticks.map((t) => t.label)).toEqual([
      '22:00',
      '22:30',
      '23:00',
      '23:30',
      '4 Nov',
      '00:30',
      '01:00',
      '01:30',
      '02:00'
    ])
    const week = timeScale({ start: local(9, 0, 1), end: local(9, 0, 8) }, 700)
    expect(week.step).toBe(86_400_000)
    expect(week.ticks.map((t) => t.label)).toEqual([
      '2 Nov',
      '3 Nov',
      '4 Nov',
      '5 Nov',
      '6 Nov',
      '7 Nov',
      '8 Nov'
    ])
    expect(week.ticks.every((t) => t.day)).toBe(true)
  })

  it('widens a span shorter than a minute to one minute', () => {
    const one = timeScale({ start: local(9), end: local(9) }, 300)
    expect(one.end - one.start).toBe(60_000)
    expect(one.x(local(9, 1))).toBe(300)
  })
})

describe('a block on the scale', () => {
  it('is at least three pixels wide, and stays inside the width', () => {
    const scale = timeScale({ start: local(9), end: local(10) }, 600)
    expect(blockRect(scale, block(local(9), local(9, 30)))).toEqual({ x: 0, w: 300 })
    expect(blockRect(scale, block(local(9, 59), local(9, 59)))).toEqual({ x: 590, w: 3 })
    const end = blockRect(scale, block(local(10), local(10)))
    expect(end.x + end.w).toBe(600)
  })
})

describe('the waits', () => {
  it('are the silences between consecutive blocks', () => {
    const list = [
      block(local(9), local(9, 30)),
      block(local(10, 15), local(10, 20)),
      block(local(10, 20), local(11))
    ]
    expect(waits(list)).toEqual([{ from: iso(local(9, 30)), to: iso(local(10, 15)), minutes: 45 }])
    expect(waits([list[0]!])).toEqual([])
  })
})

describe('the lanes', () => {
  it('are the session rows in order, with their state and their blocks', () => {
    const row = (id: string, kind: 'session' | 'subagent', state: ViewRow['state']): ViewRow => ({
      id,
      kind,
      name: `Row ${id}`,
      type: null,
      description: null,
      model: null,
      state,
      figures: emptyFigures(),
      blocks: [block(local(9), local(9, 10))],
      children: []
    })
    const lanes = laneRows([
      row('b', 'session', 'working'),
      row('s', 'subagent', null),
      row('a', 'session', 'ended')
    ])
    expect(lanes.map((l) => [l.id, l.label, l.state, l.blocks.length])).toEqual([
      ['b', 'Row b', 'working', 1],
      ['a', 'Row a', 'ended', 1]
    ])
  })
})

describe('the words', () => {
  it('say when, how long, what a block held and its pace', () => {
    expect(formatClock(local(9, 5))).toBe('09:05')
    expect(formatDay(local(9))).toBe('4 Nov')
    expect(formatDuration(46)).toBe('46 min')
    expect(formatDuration(65)).toBe('1 h 05')
    expect(formatDuration(49 * 60 + 30)).toBe('2 d 01 h')
    expect(blockWords(block(local(9, 2), local(9, 48), 31, 92))).toEqual([
      '09:02 to 09:48 · 46 min',
      '31 messages, 92 tool calls, 2.0 a minute'
    ])
    expect(blockWords(block(local(9), local(9), 1, 0))[1]).toBe('1 message, no tool call')
    expect(blockWords(block(local(9), local(9), 1, 2))[1]).toBe(
      '1 message, 2 tool calls, 2 a minute'
    )
    expect(waitWords({ from: iso(local(9, 30)), to: iso(local(10, 42)), minutes: 72 })).toEqual([
      'Waited 1 h 12',
      '09:30 to 10:42'
    ])
  })
})
