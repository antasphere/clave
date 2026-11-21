import { describe, expect, it } from 'vitest'
import type { SubAgent } from '../terminal-status'
import type { WorkRow } from '../work'
import { closedDock, dockMarks, nextDock, type DockEvent, type DockState } from './folio-work'

const row = (id: string, gone = false): WorkRow => ({
  agent: { id, kind: 'agent' } as SubAgent,
  gone
})
const run = (events: DockEvent[], start: DockState = closedDock): DockState =>
  events.reduce(nextDock, start)

describe('dockMarks', () => {
  it('shows every row up to four, with no overflow', () => {
    const { marks, overflow } = dockMarks([row('a'), row('b'), row('c')])
    expect(marks.map((m) => m.agent.id)).toEqual(['a', 'b', 'c'])
    expect(overflow).toBe(0)
  })
  it('shows the first four and counts the running rest', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => row(id))
    const { marks, overflow } = dockMarks(rows)
    expect(marks.map((m) => m.agent.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(overflow).toBe(3)
  })
  it('a leaving row past the four is no overflow', () => {
    const rows = [...['a', 'b', 'c', 'd', 'e'].map((id) => row(id)), row('z', true)]
    expect(dockMarks(rows).overflow).toBe(1)
  })
  it('takes another maximum', () => {
    expect(dockMarks([row('a'), row('b')], 1)).toMatchObject({ overflow: 1 })
  })
})

describe('nextDock', () => {
  it('the pointer over the pill opens it after the beat, as hover', () => {
    const waiting = run(['pointer-in'])
    expect(waiting).toEqual({ open: null, pending: 'open', held: false })
    expect(nextDock(waiting, 'beat')).toEqual({ open: 'hover', pending: null, held: false })
  })
  it('the pointer gone before the beat opens nothing', () => {
    expect(run(['pointer-in', 'pointer-out', 'beat'])).toEqual(closedDock)
  })
  it('the pointer gone closes it after the beat', () => {
    const leaving = run(['pointer-in', 'beat', 'pointer-out'])
    expect(leaving).toMatchObject({ open: 'hover', pending: 'close' })
    expect(nextDock(leaving, 'beat')).toEqual(closedDock)
  })
  it('pointer-out then pointer-in before the beat keeps it open', () => {
    expect(run(['pointer-in', 'beat', 'pointer-out', 'pointer-in', 'beat'])).toEqual({
      open: 'hover',
      pending: null,
      held: false
    })
  })
  it('a pointer coming back over an open dock asks for nothing', () => {
    const open = run(['pointer-in', 'beat'])
    expect(nextDock(open, 'pointer-in')).toBe(open)
  })
  it('a beat with nothing pending changes nothing', () => {
    const open = run(['pointer-in', 'beat'])
    expect(nextDock(open, 'beat')).toBe(open)
    expect(nextDock(closedDock, 'beat')).toBe(closedDock)
  })
  it('focus inside opens it at once, and focus gone closes it', () => {
    const focused = run(['focus-in'])
    expect(focused).toEqual({ open: 'focus', pending: null, held: false })
    expect(nextDock(focused, 'focus-out')).toEqual(closedDock)
  })
  it('focus outranks hover: the pointer leaving a focused dock leaves it open', () => {
    const focused = run(['pointer-in', 'beat', 'focus-in', 'pointer-out', 'beat'])
    expect(focused.open).toBe('focus')
  })
  it('focus-in calls off a close on its way', () => {
    expect(run(['pointer-in', 'beat', 'pointer-out', 'focus-in'])).toMatchObject({
      open: 'focus',
      pending: null
    })
  })
  it('focus-out of a hover-opened dock leaves the hover to the pointer', () => {
    const open = run(['pointer-in', 'beat'])
    expect(nextDock(open, 'focus-out')).toBe(open)
  })
  it('a click on the pill pins it, and a second click unpins it', () => {
    const pinned = run(['pill-click'])
    expect(pinned).toEqual({ open: 'pinned', pending: null, held: false })
    expect(nextDock(pinned, 'pill-click')).toEqual(closedDock)
  })
  it('a click pins a dock the pointer or the focus opened', () => {
    expect(run(['pointer-in', 'beat', 'pill-click']).open).toBe('pinned')
    expect(run(['focus-in', 'pill-click']).open).toBe('pinned')
  })
  it('a pinned dock ignores pointer-out, focus-in and focus-out', () => {
    const pinned = run(['pill-click'])
    expect(nextDock(pinned, 'pointer-out')).toBe(pinned)
    expect(nextDock(pinned, 'focus-in')).toBe(pinned)
    expect(nextDock(pinned, 'focus-out')).toBe(pinned)
    expect(run(['pointer-out', 'beat'], pinned)).toEqual(pinned)
  })
  it('escape closes all three', () => {
    for (const opened of [['pointer-in', 'beat'], ['focus-in'], ['pill-click']] as DockEvent[][])
      expect(run([...opened, 'escape'])).toEqual(closedDock)
  })
  it('a pointer down anywhere else closes all three', () => {
    for (const opened of [['pointer-in', 'beat'], ['focus-in'], ['pill-click']] as DockEvent[][])
      expect(run([...opened, 'outside'])).toEqual(closedDock)
  })
  it('escape and outside call off a pending open', () => {
    expect(run(['pointer-in', 'escape'])).toEqual(closedDock)
  })
  it('a window open holds it open: through the pointer leaving, the focus leaving, Escape and a click outside', () => {
    const held = run(['pointer-in', 'beat', 'window-open'])
    expect(held).toEqual({ open: 'hover', pending: null, held: true })
    expect(run(['pointer-out', 'beat', 'focus-out', 'escape', 'outside'], held)).toEqual(held)
    const focusedHeld = run(['focus-in', 'window-open', 'focus-out'])
    expect(focusedHeld.open).toBe('focus')
  })
  it('a close on its way when the window opens is called off', () => {
    expect(run(['pointer-in', 'beat', 'pointer-out', 'window-open', 'beat'])).toMatchObject({
      open: 'hover',
      held: true
    })
  })
  it('the window closed, the dock answers again', () => {
    const released = run(['pointer-in', 'beat', 'window-open', 'window-close'])
    expect(released).toEqual({ open: 'hover', pending: null, held: false })
    expect(run(['pointer-out', 'beat'], released)).toEqual(closedDock)
    expect(nextDock(released, 'escape')).toEqual(closedDock)
  })
})
