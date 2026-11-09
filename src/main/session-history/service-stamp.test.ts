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

import {
  STAMP_REMOTE_TIMEOUT_MS,
  resetStampRemoteBackoff,
  restampLaunch,
  stampHistory,
  type StampRecordSource
} from './service'

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

const stamp = (r: Record<string, unknown>): Promise<void> => stampHistory(r)

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

describe('a server that does not answer (round 5, V5-F2)', () => {
  it('writes the row without the record after the timeout, and asks no more for a while', async () => {
    vi.useFakeTimers()
    try {
      resetStampRemoteBackoff()
      let asked = 0
      const source: StampRecordSource = {
        local: () => null,
        remote: () => {
          asked++
          return new Promise(() => {})
        }
      }
      const before = written().length
      const first = stampHistory(row('slow-1', { claudeSessionId: 'cc-slow-1' }), source)
      await vi.advanceTimersByTimeAsync(STAMP_REMOTE_TIMEOUT_MS + 1)
      await first
      expect(written().length).toBe(before + 1)
      expect(written().at(-1)).toMatchObject({ sessionId: 'slow-1', dangerous: true })
      expect(written().at(-1)).not.toHaveProperty('permissionMode')
      expect(asked).toBe(1)
      // The next row writes at once: the server is left alone for a while.
      await stampHistory(row('slow-2', { claudeSessionId: 'cc-slow-2' }), source)
      expect(written().length).toBe(before + 2)
      expect(asked).toBe(1)
    } finally {
      vi.useRealTimers()
      resetStampRemoteBackoff()
    }
  })
})

describe('restampLaunch: a closing tab’s launch written from its record (round 6, V6-F1)', () => {
  it('writes the tab’s latest row again, placed, with the record’s mode, effort and account', async () => {
    await stamp(
      row('closing-1', { claudeSessionId: 'cc-closing-1', groupId: 'g1', groupName: 'Work' })
    )
    const before = written().length
    await restampLaunch('closing-1', {
      id: 'closing-1',
      cwd: '/tmp/proj',
      folderName: 'proj',
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: true,
      permissionMode: 'plan',
      effort: 'high',
      claudeProfileId: 'acct-9',
      claudeProfileLabel: 'Anthropic'
    } as never)
    expect(written().length).toBe(before + 1)
    expect(written().at(-1)).toMatchObject({
      kind: 'placed',
      sessionId: 'closing-1',
      groupId: 'g1',
      groupName: 'Work',
      dangerous: false,
      permissionMode: 'plan',
      effort: 'high',
      accountId: 'acct-9',
      accountLabel: 'Anthropic'
    })
  })

  it('copies the tab’s LATEST row, not its first (round 7, V7-F2)', async () => {
    await stamp(
      row('moved-1', { claudeSessionId: 'cc-moved-1', name: 'first name', groupId: 'g1' })
    )
    await stamp(
      row('moved-1', {
        claudeSessionId: 'cc-moved-1',
        name: 'second name',
        groupId: 'g2',
        groupName: 'Later',
        ts: '2026-11-09T11:00:00.000Z'
      })
    )
    await restampLaunch('moved-1', {
      id: 'moved-1',
      cwd: '/tmp/proj',
      folderName: 'proj',
      claudeMode: true,
      antigravityMode: false,
      codexMode: false,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: false,
      permissionMode: 'acceptEdits'
    } as never)
    expect(written().at(-1)).toMatchObject({
      sessionId: 'moved-1',
      name: 'second name',
      groupId: 'g2',
      groupName: 'Later',
      permissionMode: 'acceptEdits'
    })
  })

  it('writes nothing for a tab the ledger never saw', async () => {
    const before = written().length
    await restampLaunch('never-seen', { id: 'never-seen', cwd: '/x', folderName: 'x' } as never)
    expect(written().length).toBe(before)
  })
})
