/**
 * The stamp's launch (PRDCT-4236): a ledger row is written with the mode and
 * the effort the session's record keeps, main's own record first, the
 * server's when main keeps none, and a record that cannot be read never
 * loses the row. Rows are written in the order they were stamped.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// The ledger's directory is read at the first stamp, after `dir` is made.
vi.mock('electron', () => ({ app: { getPath: () => process.env.CLAVE_STAMP_TEST_DIR } }))

import { stampHistory, type StampRecordSource } from './service'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-stamp-test-'))
process.env.CLAVE_STAMP_TEST_DIR = dir

const ledger = path.join(dir, 'session-history', 'ledger.jsonl')
const written = (): Record<string, unknown>[] =>
  fs.existsSync(ledger)
    ? fs
        .readFileSync(ledger, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

const row = (sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  kind: 'placed',
  ts: '2026-11-09T10:00:00.000Z',
  sessionId,
  claudeSessionId: 'cc-' + sessionId,
  name: 'tab',
  cwd: '/tmp/proj',
  mode: 'claude',
  model: null,
  workspaceId: null,
  groupId: null,
  groupName: null,
  dangerous: true,
  ...over
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAVE_STAMP_TEST_DIR
})

describe('stampHistory enriches the row from the session record', () => {
  it('reads main’s record first: mode, effort, and the model when the row has none', async () => {
    const source: StampRecordSource = {
      local: (id) =>
        id === 'a' ? { permissionMode: 'plan', effort: 'high', model: 'claude-fable-5' } : null,
      remote: vi.fn(async () => ({ permissionMode: 'auto' }))
    }
    await stampHistory(row('a'), source)
    expect(written().at(-1)).toMatchObject({
      sessionId: 'a',
      dangerous: true,
      permissionMode: 'plan',
      effort: 'high',
      model: 'claude-fable-5'
    })
    expect(source.remote).not.toHaveBeenCalled()
    // A row that names its model keeps it.
    await stampHistory(row('a', { model: 'opus' }), source)
    expect(written().at(-1)).toMatchObject({ model: 'opus', permissionMode: 'plan' })
  })

  it('asks the server when main keeps no record', async () => {
    await stampHistory(row('b'), {
      local: () => null,
      remote: async () => ({ permissionMode: 'acceptEdits', effort: 'low' })
    })
    expect(written().at(-1)).toMatchObject({
      sessionId: 'b',
      permissionMode: 'acceptEdits',
      effort: 'low'
    })
  })

  it('a record that cannot be read never loses the row, and the order holds', async () => {
    let release: () => void = () => {}
    const slow = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })
    const first = stampHistory(row('c'), { local: () => null, remote: () => slow })
    const second = stampHistory(row('d'), {
      local: () => {
        throw new Error('unreadable')
      },
      remote: async () => {
        throw new Error('server gone')
      }
    })
    release()
    await Promise.all([first, second])
    const last = written().slice(-2)
    expect(last.map((r) => r.sessionId)).toEqual(['c', 'd'])
    expect(last[1]).not.toHaveProperty('permissionMode')
    expect(last[1]).toMatchObject({ dangerous: true })
  })
})
