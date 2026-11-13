import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UnrecognisedTranscriptError } from '../ir.ts'
import { findCodexRollout, readCodex, replayCodexHistory } from './codex.ts'

const fixtures = join(import.meta.dirname, '..', '..', 'fixtures')
const hello = join(fixtures, 'codex-rollout-0.167-hello.jsonl')
const THREAD = '01a1c137-0bc0-7813-80a4-0e81f6fb05c6'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('reading a Codex 0.167 rollout', () => {
  it('reads the head from session_meta and the turn context', () => {
    const { head } = readCodex(hello)
    expect(head).toEqual({
      provider: 'codex',
      id: THREAD,
      model: 'gpt-5.6-sol',
      cwd: '/Users/example/.antasphere',
      cliVersion: '0.167.0',
      startedAt: Date.parse('2026-11-09T16:49:32.700Z'),
      endedAt: Date.parse('2026-11-09T16:49:37.040Z'),
      source: hello
    })
  })
  it("replays the person's items and not the model's injected instructions", () => {
    const events = readCodex(hello).items.map((i) => i.event)
    expect(events).toEqual([
      { type: 'user_message', text: 'Hello' },
      { type: 'assistant_text', delta: 'Hello! What are we working on today?', final: true },
      { type: 'context_usage', used: 26946, window: 258400 }
    ])
  })
  it('reads older response-item turns too, with their tool pairs', () => {
    const row = (type: string, payload: unknown): string =>
      JSON.stringify({ timestamp: '2026-07-27T13:57:38.000Z', type, payload })
    const events = replayCodexHistory([
      row('event_msg', { type: 'task_started', turn_id: 't1' }),
      row('response_item', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'rules' }]
      }),
      row('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }]
      }),
      row('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run pwd' }]
      }),
      row('response_item', {
        type: 'function_call',
        call_id: 'c1',
        name: 'shell',
        arguments: '{"command":["pwd"]}'
      }),
      row('response_item', { type: 'function_call_output', call_id: 'c1', output: '/project' }),
      row('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '/project' }]
      })
    ]).map((i) => i.event)
    expect(events).toEqual([
      { type: 'user_message', text: 'run pwd' },
      { type: 'tool_call', id: 'c1', name: 'shell', input: { command: ['pwd'] } },
      { type: 'tool_result', id: 'c1', output: '/project' },
      { type: 'assistant_text', delta: '/project', final: true }
    ])
  })
  it('finds a thread by id under the home, by the file name', () => {
    const home = mkdtempSync(join(tmpdir(), 'session-bridge-codex-'))
    dirs.push(home)
    const day = join(home, 'sessions', '2026', '11', '09')
    mkdirSync(day, { recursive: true })
    const copy = join(day, `rollout-2026-11-09T17-49-32-${THREAD}.jsonl`)
    cpSync(hello, copy)
    expect(findCodexRollout(THREAD, home)).toBe(copy)
    expect(findCodexRollout('01a1c137-0000-0000-0000-000000000000', home)).toBeNull()
    expect(readCodex(THREAD, home).head.id).toBe(THREAD)
    expect(findCodexRollout(THREAD, join(home, 'missing'))).toBeNull()
  })
  it('refuses a file without a session_meta row, and an id with no file', () => {
    const home = mkdtempSync(join(tmpdir(), 'session-bridge-codex-'))
    dirs.push(home)
    expect(() => readCodex('no-such-thread', home)).toThrow(UnrecognisedTranscriptError)
    const claude = join(fixtures, 'claude-transcript-sample.jsonl')
    expect(() => readCodex(claude, home)).toThrow(/no session_meta/)
    const noId = join(home, 'noid.jsonl')
    writeFileSync(noId, JSON.stringify({ type: 'session_meta', payload: { cwd: '/x' } }))
    expect(() => readCodex(noId, home)).toThrow(UnrecognisedTranscriptError)
  })
})
