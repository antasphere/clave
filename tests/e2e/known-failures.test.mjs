import { describe, it, expect } from 'vitest'
import { loadKnown, classify, summarize } from './known-failures.mjs'

describe('loadKnown', () => {
  it('takes an absent file as nothing known', () => {
    expect(loadKnown(null)).toEqual({ why: '', specs: {}, unstable: [] })
  })

  it('reads specs and unstable', () => {
    const k = loadKnown({ why: 'w', specs: { 'a.spec.mjs': ['x'] }, unstable: ['b.spec.mjs'] })
    expect(k).toEqual({ why: 'w', specs: { 'a.spec.mjs': ['x'] }, unstable: ['b.spec.mjs'] })
  })

  it('refuses a "ran to completion" check: a crash is never known', () => {
    expect(() =>
      loadKnown({ specs: { 'chat-view.spec.mjs': ['chat-view.spec.mjs ran to completion'] } })
    ).toThrow(/cannot be a known failure.*unstable/)
  })

  it('refuses a spec listed both ways', () => {
    expect(() => loadKnown({ specs: { 'a.spec.mjs': ['x'] }, unstable: ['a.spec.mjs'] })).toThrow(
      /one or the other/
    )
  })

  it('refuses malformed shapes', () => {
    expect(() => loadKnown({ specs: [] })).toThrow()
    expect(() => loadKnown({ specs: { 'a.spec.mjs': 'x' } })).toThrow()
    expect(() => loadKnown({ unstable: 'a.spec.mjs' })).toThrow()
  })
})

describe('classify and summarize', () => {
  const known = loadKnown({ specs: { 'a.spec.mjs': ['listed'] }, unstable: ['u.spec.mjs'] })

  it('a listed check that fails is known; an unlisted one fails', () => {
    expect(classify('a.spec.mjs', 'listed', false, known).kind).toBe('known')
    expect(classify('a.spec.mjs', 'other', false, known).kind).toBe('fail')
  })

  it('a listed check that passes is a pass, and reported', () => {
    const r = summarize({ 'a.spec.mjs': [{ name: 'listed', ok: true }] }, known)
    expect(r.totals).toEqual({ passed: 1, failed: 0, known: 0, unstable: 0 })
    expect(r.recovered).toEqual(['a.spec.mjs: listed'])
    expect(r.exitCode).toBe(0)
  })

  it('a crash of a listed spec is still a failure: the runner check is never known', () => {
    const r = summarize(
      { 'a.spec.mjs': [{ name: 'a.spec.mjs ran to completion', ok: false }] },
      known
    )
    expect(r.totals.failed).toBe(1)
    expect(r.exitCode).toBe(1)
  })

  it('an unstable spec never fails the run, and its failures are counted apart', () => {
    const r = summarize(
      {
        'u.spec.mjs': [
          { name: 'one', ok: true },
          { name: 'u.spec.mjs ran to completion', ok: false }
        ]
      },
      known
    )
    expect(r.totals).toEqual({ passed: 1, failed: 0, known: 0, unstable: 1 })
    expect(r.exitCode).toBe(0)
    expect(r.unstablePassed).toEqual([])
  })

  it('an unstable spec that passed in full is reported so it can be unlisted', () => {
    const r = summarize({ 'u.spec.mjs': [{ name: 'one', ok: true }] }, known)
    expect(r.unstablePassed).toEqual(['u.spec.mjs'])
  })

  it('an unlisted failure anywhere fails the run', () => {
    const r = summarize(
      { 'a.spec.mjs': [{ name: 'listed', ok: false }], 'z.spec.mjs': [{ name: 'q', ok: false }] },
      known
    )
    expect(r.totals).toEqual({ passed: 0, failed: 1, known: 1, unstable: 0 })
    expect(r.exitCode).toBe(1)
  })
})
