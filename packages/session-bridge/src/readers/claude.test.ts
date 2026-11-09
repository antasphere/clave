import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UnrecognisedTranscriptError } from '../ir.ts'
import { findClaudeTranscript, readClaude, replayClaudeTranscript } from './claude.ts'

const fixtures = join(import.meta.dirname, '..', '..', 'fixtures')
const sample = join(fixtures, 'claude-transcript-sample.jsonl')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('reading a Claude Code transcript', () => {
  it('reads the head: session, cwd, version, the model that answered, first and last time', () => {
    const { head } = readClaude(sample)
    expect(head).toEqual({
      provider: 'claude',
      id: '11111111-1111-4111-8111-111111111111',
      model: 'claude-opus-5-5',
      cwd: '/Users/example/project',
      cliVersion: '2.1.319',
      startedAt: Date.parse('2026-11-09T10:00:00.000Z'),
      endedAt: Date.parse('2026-11-09T10:01:12.000Z'),
      source: sample
    })
  })
  it('replays the conversation and nothing of the CLI: subagent and meta rows out, commands read back, a dead call closed at the next message', () => {
    const events = readClaude(sample).items.map((i) => i.event)
    expect(events).toEqual([
      {
        type: 'user_message',
        text: 'List the files here, then write hello.txt with the word hello.'
      },
      { type: 'context_usage', used: 1242, window: null },
      { type: 'assistant_text', delta: 'Listing the folder first.', final: true },
      {
        type: 'tool_call',
        id: 'toolu_01',
        name: 'Bash',
        input: { command: 'ls', description: 'List files' }
      },
      { type: 'tool_result', id: 'toolu_01', output: 'README.md\nsrc\n' },
      {
        type: 'tool_call',
        id: 'toolu_02',
        name: 'Write',
        input: { file_path: '/Users/example/project/hello.txt', content: 'hello\n' }
      },
      { type: 'context_usage', used: 1562, window: null },
      {
        type: 'tool_result',
        id: 'toolu_02',
        output: 'File created successfully at: /Users/example/project/hello.txt'
      },
      {
        type: 'tool_call',
        id: 'toolu_03',
        name: 'Read',
        input: { file_path: '/Users/example/project/hello.txt' }
      },
      { type: 'tool_result', id: 'toolu_03', output: [{ type: 'text', text: '     1\thello' }] },
      {
        type: 'assistant_text',
        delta: 'Done: the folder holds README.md and src, and hello.txt now says hello.',
        final: true
      },
      { type: 'user_message', text: '/review src' },
      { type: 'tool_call', id: 'toolu_04', name: 'Grep', input: { pattern: 'TODO', path: 'src' } },
      { type: 'turn_interrupted' },
      { type: 'tool_result', id: 'toolu_04', output: undefined },
      { type: 'user_message', text: 'Never mind, thanks.' },
      { type: 'assistant_text', delta: 'All right.', final: true }
    ])
  })
  it('dates every event by its row', () => {
    const items = readClaude(sample).items
    expect(items[0].at).toBe(Date.parse('2026-11-09T10:00:00.000Z'))
    expect(
      items
        .filter((i) => i.event.type !== 'tool_result' || i.event.output !== undefined)
        .every((i) => typeof i.at === 'number')
    ).toBe(true)
  })
  it("reads the CLI's stream-json frames the same way (Clave's captures)", () => {
    const lines = (name: string): string[] => readFileSync(join(fixtures, name), 'utf8').split('\n')
    expect(
      replayClaudeTranscript(lines('claude-stream-real-turn.ndjson')).map((i) => i.event)
    ).toEqual([
      { type: 'assistant_text', delta: 'CLAVE_OK', final: true },
      { type: 'context_usage', used: expect.any(Number), window: null }
    ])
    const denied = replayClaudeTranscript(lines('claude-stream-permission-turn.ndjson')).map(
      (i) => i.event
    )
    expect(denied).toContainEqual({
      type: 'tool_result',
      id: 'toolu_015Y3ySsZMuf2QBjUDQihSbS',
      output: 'Denied by user',
      error: true
    })
  })
  it('finds a transcript by id under the cwd folder, or anywhere in the store when the cwd moved', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'session-bridge-claude-'))
    dirs.push(configDir)
    const cwd = '/Users/example/project'
    const dashed = join(configDir, 'projects', '-Users-example-project')
    mkdirSync(dashed, { recursive: true })
    writeFileSync(join(dashed, 'abc.jsonl'), '')
    expect(findClaudeTranscript('abc', cwd, configDir)).toBe(join(dashed, 'abc.jsonl'))
    expect(findClaudeTranscript('abc', '/somewhere/else', configDir)).toBe(
      join(dashed, 'abc.jsonl')
    )
    expect(findClaudeTranscript('nope', cwd, configDir)).toBeNull()
    expect(findClaudeTranscript('abc', cwd, join(configDir, 'missing'))).toBeNull()
  })
  it("refuses a file with no conversation in it, or another provider's storage", () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-bridge-claude-'))
    dirs.push(dir)
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '\n')
    expect(() => readClaude(empty)).toThrow(UnrecognisedTranscriptError)
    expect(() => readClaude(join(fixtures, 'codex-rollout-0.167-hello.jsonl'))).toThrow(
      /Not a claude transcript/
    )
    const noId = join(dir, 'noid.jsonl')
    writeFileSync(noId, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }))
    expect(() => readClaude(noId)).toThrow(/no sessionId/)
  })
})
