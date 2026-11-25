import { describe, expect, it } from 'vitest'
import {
  PROJECT_FLOORS,
  rankShares,
  readGroupProjects,
  readProjectChoice,
  sanitizeTabProjects,
  sharePercent,
  type TabProjects
} from './tab-projects-rules'

// Invented projects, as every fixture of this repository: never a real one.
const FITS = 0.95

const names = (shares: ReadonlyArray<{ name: string }>): string[] => shares.map((s) => s.name)

describe('rankShares', () => {
  it('orders by share, then by name, and drops what is not a share', () => {
    expect(
      rankShares({
        Quill: 0.2,
        Atlas: 0.6,
        Lumen: 0.2,
        bad: Number.NaN,
        text: 'x',
        over: 1.5,
        neg: -0.1
      })
    ).toEqual([
      { name: 'Atlas', p: 0.6 },
      { name: 'Lumen', p: 0.2 },
      { name: 'Quill', p: 0.2 }
    ])
  })
})

describe('readProjectChoice', () => {
  it('decides on one project that holds the floor alone', () => {
    const reading = readProjectChoice({ Quill: 0.97, Atlas: 0.02, Lumen: 0.01 }, FITS)
    expect(reading.status).toBe('decided')
    expect(names(reading.shares)).toEqual(['Quill'])
  })

  it('decides at the floor itself', () => {
    expect(readProjectChoice({ Quill: 0.9, Atlas: 0.1 }, FITS).status).toBe('decided')
  })

  it('names two projects that hold the floor together (measured: 0.66 and 0.33)', () => {
    const reading = readProjectChoice({ Lumen: 0.66, Atlas: 0.33, Quill: 0.01 }, FITS)
    expect(reading.status).toBe('decided')
    expect(names(reading.shares)).toEqual(['Lumen', 'Atlas'])
  })

  it('never names a second project while the first holds the floor alone', () => {
    // The task's two floors cannot both apply to one project: 0.90 leaves 0.10.
    const reading = readProjectChoice({ Quill: 0.9, Atlas: 0.1 }, FITS)
    expect(names(reading.shares)).toEqual(['Quill'])
  })

  it('stays undecided when two projects do not hold the floor together (measured: 0.63 and 0.23)', () => {
    const reading = readProjectChoice({ Atlas: 0.63, Tern: 0.23, Quill: 0.08, Lumen: 0.06 }, FITS)
    expect(reading.status).toBe('undecided')
    expect(names(reading.shares)).toEqual(['Atlas', 'Tern'])
  })

  it('stays undecided when the next project is under its own floor', () => {
    // 0.85 alone is short, and 0.10 is too small to be named beside it.
    const reading = readProjectChoice({ Quill: 0.85, Atlas: 0.1, Lumen: 0.05 }, FITS)
    expect(reading.status).toBe('undecided')
    expect(names(reading.shares)).toEqual(['Quill', 'Atlas'])
  })

  it('names three projects, and never more', () => {
    const three = readProjectChoice({ Quill: 0.4, Atlas: 0.3, Lumen: 0.25, Tern: 0.05 }, FITS)
    expect(three.status).toBe('decided')
    expect(names(three.shares)).toEqual(['Quill', 'Atlas', 'Lumen'])
    const four = readProjectChoice({ Quill: 0.3, Atlas: 0.3, Lumen: 0.2, Tern: 0.2 }, FITS)
    expect(four.status).toBe('undecided')
    expect(names(four.shares)).toEqual(['Atlas', 'Quill'])
  })

  it('reads a sum that floating point puts a hair under the floor as the floor', () => {
    expect(0.7 + 0.2).toBeLessThan(0.9)
    expect(readProjectChoice({ Quill: 0.7, Atlas: 0.2, Lumen: 0.1 }, FITS).status).toBe('decided')
  })

  it('answers none when no project fits, however sure the choice (measured: 0.97 with 0.20)', () => {
    const reading = readProjectChoice({ Tern: 0.97, Atlas: 0.02, Quill: 0.01 }, 0.2)
    expect(reading).toEqual({ status: 'none', shares: [] })
  })

  it('answers none at a hair under the fits floor and decides at it', () => {
    expect(readProjectChoice({ Quill: 0.97 }, PROJECT_FLOORS.fits - 0.01).status).toBe('none')
    expect(readProjectChoice({ Quill: 0.97 }, PROJECT_FLOORS.fits).status).toBe('decided')
  })

  it('answers none on an answer with no share or a fits that is not a probability', () => {
    expect(readProjectChoice({}, FITS).status).toBe('none')
    expect(readProjectChoice({ Quill: 0.97 }, Number.NaN).status).toBe('none')
  })

  it('reads the same answer the same way whatever the order of its keys', () => {
    const a = readProjectChoice({ Atlas: 0.5, Quill: 0.5 }, FITS)
    const b = readProjectChoice({ Quill: 0.5, Atlas: 0.5 }, FITS)
    expect(a).toEqual(b)
    expect(names(a.shares)).toEqual(['Atlas', 'Quill'])
  })
})

const tab = (status: TabProjects['status'], picks: Array<[string, number]>): TabProjects => ({
  status,
  picks: picks.map(([name, p]) => ({
    file: `/w/${name.toLowerCase()}/.clave/workspaces/default.clave`,
    name,
    p
  })),
  fits: status === 'none' ? 0.1 : 0.95,
  readAt: 1,
  model: 'jev-1.14.0',
  basis: 'b'
})

describe('readGroupProjects', () => {
  it('names a group after the one project of its tabs', () => {
    expect(
      readGroupProjects([tab('decided', [['Quill', 0.97]]), tab('decided', [['Quill', 1]])])
    ).toEqual({
      status: 'named',
      name: 'Quill',
      projects: [{ name: 'Quill', share: 0.985 }]
    })
  })

  it('joins the projects of its tabs in the order of their mean share', () => {
    const reading = readGroupProjects([
      tab('decided', [['Atlas', 0.95]]),
      tab('decided', [['Lumen', 1]]),
      tab('decided', [
        ['Lumen', 0.66],
        ['Atlas', 0.33]
      ])
    ])
    expect(reading.status).toBe('named')
    expect(reading.status === 'named' && reading.name).toBe('Lumen | Atlas')
  })

  it('does not name a group while one tab hesitates, and offers the two nearest', () => {
    const reading = readGroupProjects([
      tab('decided', [['Quill', 0.97]]),
      tab('undecided', [
        ['Atlas', 0.63],
        ['Tern', 0.23]
      ])
    ])
    expect(reading.status).toBe('suggested')
    expect(reading.status === 'suggested' && reading.nearest.map((p) => p.name)).toEqual([
      'Quill',
      'Atlas'
    ])
  })

  it('leaves out a tab with no reading and a tab no project fits', () => {
    expect(
      readGroupProjects([tab('decided', [['Quill', 0.97]]), null, undefined, tab('none', [])])
    ).toEqual({
      status: 'named',
      name: 'Quill',
      projects: [{ name: 'Quill', share: 0.97 }]
    })
  })

  it('has nothing to say when no tab was read or none was placed', () => {
    expect(readGroupProjects([])).toEqual({ status: 'unread' })
    expect(readGroupProjects([null, tab('none', [])])).toEqual({ status: 'unread' })
  })
})

describe('sharePercent', () => {
  it('rounds a share to a whole percentage', () => {
    expect(sharePercent(0.634)).toBe('63%')
    expect(sharePercent(1)).toBe('100%')
    expect(sharePercent(-1)).toBe('0%')
  })
})

describe('sanitizeTabProjects', () => {
  const whole = tab('decided', [['Quill', 0.97]])

  it('keeps a whole reading as it is', () => {
    expect(sanitizeTabProjects(JSON.parse(JSON.stringify(whole)))).toEqual(whole)
    expect(sanitizeTabProjects(tab('none', []))).toEqual(tab('none', []))
  })

  it('drops what is not a reading, and keeps nothing unknown', () => {
    expect(sanitizeTabProjects(null)).toBeUndefined()
    expect(sanitizeTabProjects('decided')).toBeUndefined()
    expect(sanitizeTabProjects({ ...whole, status: 'sure' })).toBeUndefined()
    expect(sanitizeTabProjects({ ...whole, fits: 2 })).toBeUndefined()
    expect(sanitizeTabProjects({ ...whole, readAt: 'now' })).toBeUndefined()
    expect(sanitizeTabProjects({ ...whole, model: '' })).toBeUndefined()
    expect(
      sanitizeTabProjects({ ...whole, picks: [{ file: '/w/a.clave', name: 'Quill' }] })
    ).toBeUndefined()
    expect(sanitizeTabProjects({ ...whole, extra: 1 })).toEqual(whole)
  })

  it('drops a reading whose status and projects disagree', () => {
    expect(sanitizeTabProjects({ ...whole, status: 'none' })).toBeUndefined()
    expect(sanitizeTabProjects({ ...whole, picks: [] })).toBeUndefined()
  })

  it('drops a reading naming more projects than a tab may', () => {
    const four = [1, 2, 3, 4].map((n) => ({ file: '/w/a.clave', name: `P${n}`, p: 0.25 }))
    expect(sanitizeTabProjects({ ...whole, picks: four })).toBeUndefined()
  })
})
