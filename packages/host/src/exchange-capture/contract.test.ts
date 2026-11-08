/**
 * Conformance of Clave's contract mirror against the exos fixtures (spec
 * §6.3): the mirrored usage reader reproduces the pinned snapshot exactly
 * (12 calls stored as 40 entries across two models + one sidecar of 3 calls),
 * the naive per-entry sum — the v1 bug — differs by the known factor, and
 * the mirrored validator accepts every valid fixture line and refuses every
 * invalid one. A mirror that drifts from the contract turns this red.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  computeUsageSnapshot,
  isKnownWorkstreamEvent,
  isUsageSnapshotV1,
  parseTranscriptLines,
  sumModelUsage,
  validateWorkstreamEvent,
  WORKSTREAM_EVENT_KINDS,
  WORKSTREAM_EVENT_VERSION
} from './contract/workstream-events'
import type { UsageSnapshot } from './contract/workstream-events'

const FIXTURES = join(__dirname, 'contract', 'fixtures')
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8')

describe('the mirrored usage reader against the contract fixture', () => {
  const root = parseTranscriptLines(read('transcript/root.jsonl'))
  const sidecar = parseTranscriptLines(read('transcript/subagents/agent-fixture01.jsonl'))
  const expected = JSON.parse(read('transcript/usage-snapshot.expected.json')) as UsageSnapshot
  const naive = JSON.parse(read('transcript/naive.expected.json')) as {
    distinctCalls: number
    entries: number
    inputSummedPerEntry: number
    inputSummedPerCall: number
  }

  it('reproduces the expected snapshot exactly', () => {
    expect(computeUsageSnapshot(root.entries, [sidecar.entries], expected.computedAt)).toEqual(
      expected
    )
  })

  it('the v1 per-entry sum is the regression this pins: entries ≠ calls, input sums differ', () => {
    let entries = 0
    let input = 0
    for (const value of [...root.entries, ...sidecar.entries]) {
      const e = value as { type?: unknown; message?: { usage?: { input_tokens?: unknown } } }
      if (e?.type !== 'assistant' || typeof e.message?.usage !== 'object') continue
      entries++
      const tokens = e.message?.usage?.input_tokens
      input += typeof tokens === 'number' ? tokens : 0
    }
    expect({ entries, input }).toEqual({ entries: naive.entries, input: naive.inputSummedPerEntry })
    const total = sumModelUsage(expected.cumulative.byModel)
    expect(total.calls).toBe(naive.distinctCalls)
    expect(total.input).toBe(naive.inputSummedPerCall)
    expect(entries).toBeGreaterThan(total.calls)
  })

  it('one unparseable line in the fixture is counted, never fatal', () => {
    expect(root.skipped).toBe(1)
  })
})

describe('the mirrored validator against the event fixtures', () => {
  const valid = read('events.valid.jsonl')
    .split('\n')
    .filter((l) => l.trim() !== '')
  const invalid = read('events.invalid.jsonl')
    .split('\n')
    .filter((l) => l.trim() !== '')

  it('accepts every valid line: one v2 line per kind, plus a v1 legacy message', () => {
    const kinds: string[] = []
    for (const line of valid) {
      const result = validateWorkstreamEvent(JSON.parse(line))
      expect(result.ok, line).toBe(true)
      if (result.ok && result.event.v === WORKSTREAM_EVENT_VERSION) {
        expect(isKnownWorkstreamEvent(result.event)).toBe(true)
        kinds.push(result.event.kind)
      }
    }
    expect(kinds.sort()).toEqual([...WORKSTREAM_EVENT_KINDS].sort())
    const legacy = valid.map((l) => JSON.parse(l)).find((e) => e.v === 1)
    expect(isUsageSnapshotV1(legacy.senderUsage)).toBe(true)
  })

  it('refuses every invalid line with at least one problem', () => {
    expect(invalid.length).toBeGreaterThanOrEqual(15)
    for (const line of invalid) {
      const result = validateWorkstreamEvent(JSON.parse(line))
      expect(result.ok, line).toBe(false)
    }
  })
})
