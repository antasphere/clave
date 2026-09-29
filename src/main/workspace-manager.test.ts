import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
vi.mock('./ipc-handlers/clave-file-handlers', () => ({
  getPreference: () => undefined,
  addTrustedRoot: () => undefined
}))

import { mergePinsPartition } from './workspace-manager'

/**
 * The state file is written one pins partition (workspace id) at a time. The
 * silent defect this guards: a pin re-stamped from the null partition to a
 * workspace id was written into the new partition while its old copy stayed in
 * the file, and the two hydrated side by side at the next boot — one more copy
 * of the same group per boot (four "Curio" groups after four restarts).
 */
const pin = (id: string, workspaceId: string | null, name = id): Record<string, unknown> => ({
  id,
  name,
  workspaceId
})

describe('mergePinsPartition — a pin id lives in exactly one partition', () => {
  it('replaces the scoped partition and leaves other workspaces alone', () => {
    const existing = [pin('a', 'ws1'), pin('b', 'ws2'), pin('c', null)]
    const next = mergePinsPartition(existing, 'ws1', [pin('a2', 'ws1')])
    expect(next).toEqual([pin('b', 'ws2'), pin('c', null), pin('a2', 'ws1')])
  })

  it('a re-stamped pin leaves its old partition when its new one is written', () => {
    const existing = [pin('curio', null, 'Curio'), pin('exos', 'ws1', 'Exos')]
    const next = mergePinsPartition(existing, 'ws1', [
      pin('exos', 'ws1', 'Exos'),
      pin('curio', 'ws1', 'Curio')
    ])
    expect(next).toEqual([pin('exos', 'ws1', 'Exos'), pin('curio', 'ws1', 'Curio')])
    expect(next.filter((p) => (p as { id: string }).id === 'curio')).toHaveLength(1)
  })

  it('the null partition is a real partition: writing it empty clears it', () => {
    const existing = [pin('curio', null), pin('exos', 'ws1')]
    expect(mergePinsPartition(existing, null, [])).toEqual([pin('exos', 'ws1')])
  })

  it("'all' replaces the whole list", () => {
    expect(mergePinsPartition([pin('a', 'ws1'), pin('b', null)], 'all', [pin('z', 'ws9')])).toEqual(
      [pin('z', 'ws9')]
    )
  })

  it('a pin without a string id is kept as-is (never matched, never dropped)', () => {
    const odd = { name: 'no id', workspaceId: null }
    expect(mergePinsPartition([odd, pin('a', 'ws1')], 'ws1', [pin('a', 'ws1')])).toEqual([
      odd,
      pin('a', 'ws1')
    ])
  })
})
