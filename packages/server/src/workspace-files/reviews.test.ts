/**
 * The review desk alone: a review is answered once, times out as Cancel,
 * and a closing desk settles what it holds and refuses what comes after,
 * so a server stopping never waits on a dialog (rounds 2 and 3 of the
 * lane's verifier watched the stop wait the timeout both ways).
 */
import { describe, expect, it } from 'vitest'
import type { ReviewRequest } from './files'
import { makeReviewDesk } from './reviews'

const request: ReviewRequest = {
  path: '/w/x.clave',
  folder: '/w',
  autoCommands: [],
  prompts: ['P'],
  dangerous: false
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the review desk', () => {
  it('answers a review once, and refuses the second word', async () => {
    const desk = makeReviewDesk({ timeoutMs: 5000 })
    let id = ''
    const asked = desk.ask(request, (reviewId) => {
      id = reviewId
    })
    await tick()
    expect(desk.pending()).toBe(1)
    expect(desk.answer(id, { response: 1, checkboxChecked: false })).toBe(true)
    expect(await asked).toEqual({ response: 1, checkboxChecked: false })
    expect(desk.answer(id, { response: 0, checkboxChecked: false })).toBe(false)
    expect(desk.pending()).toBe(0)
  })

  it('reads a silence as Cancel at the timeout', async () => {
    const desk = makeReviewDesk({ timeoutMs: 30 })
    expect(await desk.ask(request, () => {})).toBeNull()
  })

  it('cancels at once when the announce fails: nobody could answer', async () => {
    const desk = makeReviewDesk({ timeoutMs: 5000 })
    const started = Date.now()
    expect(
      await desk.ask(request, () => {
        throw new Error('not published')
      })
    ).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('closing settles every waiting review as Cancel, and a review asked after the close is Cancel at once', async () => {
    const desk = makeReviewDesk({ timeoutMs: 5000 })
    const a = desk.ask(request, () => {})
    const b = desk.ask(request, () => {})
    await tick()
    expect(desk.pending()).toBe(2)
    desk.close()
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(desk.pending()).toBe(0)
    const started = Date.now()
    let announced = false
    expect(
      await desk.ask(request, () => {
        announced = true
      })
    ).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(announced).toBe(false)
    expect(desk.pending()).toBe(0)
  })
})
