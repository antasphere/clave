import { describe, expect, it, vi } from 'vitest'
import {
  adoptableRecordsFor,
  serverHoldsRecordsFor,
  tmuxAvailableFor,
  type BootReadDeps
} from './boot-reads'

/**
 * Main's boot reads (PRDCT-3527): the records an external launch's window
 * does not take from main's own folder, and the tmux answers that wait for
 * the tmux probe instead of reading the login shell synchronously.
 */
type Rec = { id: string }
const deps = (
  external: boolean,
  order: string[] = []
): BootReadDeps<Rec> & { list: ReturnType<typeof vi.fn> } => ({
  external: () => external,
  tmuxResolvable: vi.fn(async () => {
    order.push('tmux')
  }),
  list: vi.fn((ids?: string[]) => {
    order.push(ids ? `list ${ids.join()}` : 'list')
    return ids ? ids.map((id) => ({ id })) : [{ id: 'a' }, { id: 'b' }]
  }),
  scoped: vi.fn((all: { id: string }[]) => all.filter((r) => r.id === 'a'))
})

describe('adoptableRecordsFor', () => {
  it('answers an external launch’s boot read with nothing, without listing', async () => {
    const d = deps(true)
    expect(await adoptableRecordsFor(undefined, d)).toEqual([])
    expect(d.list).not.toHaveBeenCalled()
  })
  it('still answers a read by ids when external: the re-home path', async () => {
    expect(await adoptableRecordsFor({ ids: ['x', 3] }, deps(true))).toEqual([{ id: 'x' }])
  })
  it('in-process, lists after tmux can answer and keeps this window’s share', async () => {
    const order: string[] = []
    const d = deps(false, order)
    expect(await adoptableRecordsFor(undefined, d)).toEqual([{ id: 'a' }])
    expect(order).toEqual(['tmux', 'list'])
  })
})

describe('tmuxAvailableFor', () => {
  it('asks tmux only once it can be found without the synchronous read', async () => {
    let release: () => void = () => {}
    const available = vi.fn(() => true)
    const pending = tmuxAvailableFor({
      tmuxResolvable: () => new Promise<void>((r) => (release = r)),
      available
    })
    await Promise.resolve()
    expect(available).not.toHaveBeenCalled()
    release()
    expect(await pending).toBe(true)
  })
})

describe('serverHoldsRecordsFor', () => {
  const scoped = (all: Rec[]): Rec[] => all.filter((r) => r.id.startsWith('mine'))
  it('says yes only when the window’s share of the server’s records is not empty', async () => {
    expect(await serverHoldsRecordsFor({ list: async () => [{ id: 'mine-1' }], scoped })).toBe(true)
    expect(await serverHoldsRecordsFor({ list: async () => [{ id: 'other' }], scoped })).toBe(false)
    expect(await serverHoldsRecordsFor({ list: async () => [], scoped })).toBe(false)
  })
  it('says yes when the server cannot be read, so the restore still tries', async () => {
    const list = async (): Promise<Rec[]> => {
      throw new Error('no server')
    }
    expect(await serverHoldsRecordsFor({ list, scoped })).toBe(true)
  })
})
