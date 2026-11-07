/**
 * The fs glue over the mirrored reader: the snapshot from real files (the
 * contract fixture laid out exactly like `~/.claude/projects/<dir>/`), sidecar
 * listing with spawn time and prompt, an unreadable sidecar counted but
 * summing nothing, a missing root transcript throwing (the loud
 * `*UsageError` degradation), and the store's v2 round trip.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateWorkstreamEvent } from './contract/workstream-events'
import type { UsageSnapshot } from './contract/workstream-events'
import { CaptureStore } from './store'
import { computeTokenSnapshot, listSidecars } from './transcript'

const FIXTURES = join(__dirname, 'contract', 'fixtures', 'transcript')

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clave-capture-test-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('computeTokenSnapshot (files on disk)', () => {
  it('equals the contract fixture snapshot when laid out like a Claude Code project dir', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const dir = join(tmp, '-tmp-fixture-exos-os')
    mkdirSync(join(dir, id, 'subagents'), { recursive: true })
    cpSync(join(FIXTURES, 'root.jsonl'), join(dir, `${id}.jsonl`))
    cpSync(
      join(FIXTURES, 'subagents', 'agent-fixture01.jsonl'),
      join(dir, id, 'subagents', 'agent-fixture01.jsonl')
    )
    const expected = JSON.parse(
      readFileSync(join(FIXTURES, 'usage-snapshot.expected.json'), 'utf-8')
    ) as UsageSnapshot
    const snapshot = computeTokenSnapshot(
      join(dir, `${id}.jsonl`),
      join(dir, id, 'subagents'),
      expected.computedAt
    )
    expect(snapshot).toEqual(expected)
  })

  it('a sidecar that is listed but unreadable is counted and sums nothing', () => {
    const root = join(tmp, 'root.jsonl')
    cpSync(join(FIXTURES, 'root.jsonl'), root)
    const dir = join(tmp, 'subagents')
    mkdirSync(join(dir, 'agent-broken.jsonl'), { recursive: true }) // a directory in a sidecar's place: unreadable
    const snapshot = computeTokenSnapshot(root, dir, 'x')
    expect(snapshot.cumulative.subagents).toEqual({ count: 1, byModel: {} })
    expect(snapshot.cumulative.byModel['claude-opus-5']?.calls).toBe(4) // root only
  })

  it('a missing root transcript throws — the caller turns it into a loud *UsageError', () => {
    expect(() => computeTokenSnapshot(join(tmp, 'nope.jsonl'), join(tmp, 'subagents'))).toThrow()
  })
})

describe('listSidecars', () => {
  it('lists agent-*.jsonl with spawn time and launch prompt; a missing dir is an empty list', () => {
    const dir = join(tmp, 'subagents')
    mkdirSync(dir)
    cpSync(join(FIXTURES, 'subagents', 'agent-fixture01.jsonl'), join(dir, 'agent-fixture01.jsonl'))
    writeFileSync(join(dir, 'not-a-sidecar.txt'), 'x')
    const sidecars = listSidecars(dir)
    expect(sidecars).toHaveLength(1)
    expect(sidecars[0]).toMatchObject({
      agentId: 'fixture01',
      transcriptPath: join(dir, 'agent-fixture01.jsonl'),
      prompt: 'Fixture subagent: list the files (synthesized prompt)'
    })
    expect(sidecars[0].spawnedAt).toMatch(/^2026-08-21T/)
    expect(listSidecars(join(tmp, 'absent'))).toEqual([])
  })
})

describe('CaptureStore', () => {
  it('appends v2 lines that validate, reads them back as stored, and dedups subagent discovery', () => {
    const store = new CaptureStore(join(tmp, 'exchange-capture'))
    const session = {
      sessionId: 'tab-1',
      name: 'Fixture',
      mode: 'claude' as const,
      cwd: '/tmp/fixture',
      claudeSessionId: 'host-1',
      groupId: null,
      groupName: null,
      model: null
    }
    store.append({
      v: 2,
      kind: 'session_state',
      ts: '2026-08-21T10:00:00.000Z',
      session,
      state: 'working',
      previous: null,
      source: 'hooks'
    })
    store.append({
      v: 2,
      kind: 'subagent_spawn',
      ts: '2026-08-21T10:01:00.000Z',
      discoveredAt: '2026-08-21T10:02:00.000Z',
      session,
      agentId: 'a1',
      prompt: null,
      transcriptPath: '/tmp/x'
    })
    const lines = readFileSync(store.filePath(), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(validateWorkstreamEvent(JSON.parse(line)).ok).toBe(true)
    const { events, skippedLines } = store.readAll()
    expect(events.map((e) => e.kind)).toEqual(['session_state', 'subagent_spawn'])
    expect(skippedLines).toBe(0)
    const again = new CaptureStore(join(tmp, 'exchange-capture'))
    expect(again.hasSubagent('host-1', 'a1')).toBe(true)
    expect(again.hasSubagent('host-1', 'a2')).toBe(false)
  })
})
