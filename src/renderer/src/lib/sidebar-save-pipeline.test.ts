import { describe, expect, it } from 'vitest'
import { createSavePipeline, type SaveOutcome, type SavePipeline } from './sidebar-save-pipeline'

type Snap = { revision: number; tag: string }
type Item = { json: string }
interface Harness {
  pipeline: SavePipeline<Snap>
  sent: Array<{ item: Item; base: number; answer: (o: SaveOutcome<Snap>) => void }>
  applied: Snap[]
  accepted: Array<{ json: string; revision: number }>
  edit: (json: string) => void
  tick: () => Promise<void>
}

/** A pipeline over a server the test answers by hand, one save at a time. */
function harness(initial = 0): Harness {
  const sent: Array<{ item: Item; base: number; answer: (o: SaveOutcome<Snap>) => void }> = []
  const applied: Snap[] = []
  const accepted: Array<{ json: string; revision: number }> = []
  let pending: Item | null = null
  const pipeline = createSavePipeline<Item, Snap>({
    current: () => {
      const item = pending
      pending = null
      return item
    },
    send: (item, base) =>
      new Promise((resolve) => {
        sent.push({ item, base, answer: resolve })
      }),
    apply: (snapshot) => applied.push(snapshot),
    accepted: (item, revision) => accepted.push({ json: item.json, revision })
  })
  pipeline.setRevision(initial)
  const edit = (json: string): void => {
    pending = { json }
    pipeline.save()
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  return { pipeline, sent, applied, accepted, edit, tick }
}

describe('the sidebar save pipeline', () => {
  it('sends one save at a time, the second on the revision the first answered', async () => {
    const h = harness(3)
    h.edit('a')
    h.edit('b')
    expect(h.sent.map((s) => s.item.json)).toEqual(['a'])
    expect(h.sent[0].base).toBe(3)
    h.sent[0].answer({ ok: true, revision: 4 })
    await h.tick()
    await h.tick()
    expect(h.sent.map((s) => s.item.json)).toEqual(['a', 'b'])
    expect(h.sent[1].base).toBe(4)
    expect(h.accepted).toEqual([{ json: 'a', revision: 4 }])
    expect(h.applied).toEqual([])
  })

  it('holds a snapshot pushed mid-flight and drops it when it was this window’s own echo', async () => {
    const h = harness(3)
    h.edit('a')
    h.pipeline.incoming({ revision: 4, tag: 'echo of a' })
    expect(h.applied).toEqual([])
    h.sent[0].answer({ ok: true, revision: 4 })
    await h.tick()
    await h.tick()
    expect(h.applied).toEqual([])
    expect(h.pipeline.revision()).toBe(4)
  })

  it('applies a held snapshot newer than the answer: somebody else wrote after us', async () => {
    const h = harness(3)
    h.edit('a')
    h.pipeline.incoming({ revision: 4, tag: 'echo' })
    h.pipeline.incoming({ revision: 5, tag: 'an agent' })
    h.sent[0].answer({ ok: true, revision: 4 })
    await h.tick()
    await h.tick()
    expect(h.applied).toEqual([{ revision: 5, tag: 'an agent' }])
    expect(h.pipeline.revision()).toBe(5)
  })

  it('a refused save applies the current snapshot and the queued edit goes on its revision', async () => {
    const h = harness(3)
    h.edit('a')
    h.edit('b')
    h.sent[0].answer({ ok: false, reason: 'conflict', current: { revision: 7, tag: 'theirs' } })
    await h.tick()
    await h.tick()
    expect(h.applied).toEqual([{ revision: 7, tag: 'theirs' }])
    expect(h.sent[1].base).toBe(7)
    expect(h.accepted).toEqual([])
  })

  it('ignores a snapshot at or below the revision it knows, idle or not', async () => {
    const h = harness(5)
    h.pipeline.incoming({ revision: 5, tag: 'old' })
    h.pipeline.incoming({ revision: 2, tag: 'older' })
    expect(h.applied).toEqual([])
    h.pipeline.incoming({ revision: 6, tag: 'new' })
    expect(h.applied).toEqual([{ revision: 6, tag: 'new' }])
    expect(h.pipeline.revision()).toBe(6)
  })

  it('a save that throws leaves the pipeline free for the next edit', async () => {
    const h = harness(1)
    h.edit('a')
    h.sent[0].answer(Promise.reject(new Error('gone')) as never)
    await h.tick()
    await h.tick()
    expect(h.pipeline.inFlight()).toBe(false)
    h.edit('b')
    expect(h.sent.map((s) => s.item.json)).toEqual(['a', 'b'])
  })

  it('nothing to save sends nothing', () => {
    const h = harness(1)
    h.pipeline.save()
    expect(h.sent).toEqual([])
  })
})
