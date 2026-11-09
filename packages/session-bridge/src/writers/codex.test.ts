import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from '../ir.ts'
import { readClaude } from '../readers/claude.ts'
import { readCodex } from '../readers/codex.ts'
import { UnsupportedVersionError } from '../codex/version.ts'
import { codexItemFor, codexRollout, outputText, writeCodex, type RolloutRow } from './codex.ts'

const fixtures = join(import.meta.dirname, '..', '..', 'fixtures')
const sample = (): Session => readClaude(join(fixtures, 'claude-transcript-sample.jsonl'))
const payload = (row: RolloutRow): Record<string, unknown> => row.payload
const items = (rows: RolloutRow[]): Record<string, unknown>[] =>
  rows
    .filter((r) => r.type === 'event_msg' && r.payload.type === 'item_completed')
    .map((r) => r.payload.item as Record<string, unknown>)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const NOW = Date.parse('2026-11-09T18:00:00.000Z')

describe('the rows of a Codex rollout', () => {
  const rollout = codexRollout(sample(), { threadId: 'thread-1', now: () => NOW })
  const { rows } = rollout

  it('opens with session_meta in paginated mode and numbers every row', () => {
    expect(rows[0].type).toBe('session_meta')
    expect(payload(rows[0])).toMatchObject({
      id: 'thread-1',
      session_id: 'thread-1',
      cwd: '/Users/example/project',
      runtime_workspace_roots: ['/Users/example/project'],
      history_mode: 'paginated',
      originator: 'session_bridge',
      source: 'cli',
      model_provider: 'openai',
      timestamp: '2026-11-09T10:00:00.000Z'
    })
    expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i))
    expect(rows.every((r) => !Number.isNaN(Date.parse(r.timestamp)))).toBe(true)
    expect(rollout.relativePath).toMatch(
      /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-thread-1\.jsonl$/
    )
  })
  it('writes one turn per message of the person, each opened and closed', () => {
    const types = (t: string): RolloutRow[] =>
      rows.filter((r) => r.type === 'event_msg' && r.payload.type === t)
    expect(rollout.turns).toBe(3)
    expect(types('task_started')).toHaveLength(3)
    expect(rows.filter((r) => r.type === 'turn_context')).toHaveLength(3)
    expect(types('task_complete')).toHaveLength(2)
    expect(types('turn_aborted')).toHaveLength(1)
    const started = types('task_started').map((r) => r.payload.turn_id)
    expect(new Set(started).size).toBe(3)
    for (const r of rows.filter((r) => r.type === 'turn_context'))
      expect(payload(r)).toMatchObject({
        cwd: '/Users/example/project',
        approval_policy: 'on-request',
        sandbox_policy: { type: 'workspace-write' },
        model: 'gpt-5'
      })
  })
  it('adds no instruction or environment row of its own', () => {
    const developer = rows.filter(
      (r) => r.type === 'response_item' && r.payload.role === 'developer'
    )
    expect(developer).toHaveLength(0)
    expect(
      rows.some((r) => r.type === 'response_item' && r.payload.type === 'additional_tools')
    ).toBe(false)
    expect(rows.map((r) => String(r.type))).not.toContain('world_state')
    expect(rows.some((r) => r.type === 'response_item' && r.payload.type === 'reasoning')).toBe(
      false
    )
    expect(payload(rows[0]).base_instructions).toBeUndefined()
  })
  it('prefixes the first message, and only the first, with the converted-from header', () => {
    const users = rows.filter((r) => r.type === 'response_item' && r.payload.role === 'user')
    const text = (r: RolloutRow): string =>
      ((r.payload.content as { text: string }[])[0] ?? { text: '' }).text
    expect(users).toHaveLength(3)
    expect(text(users[0])).toMatch(
      /^\[This conversation was converted from Claude Code, model claude-opus-5-5, on 9 November 2026, by @clave\/session-bridge\./
    )
    expect(text(users[0])).toMatch(
      /\n\nList the files here, then write hello\.txt with the word hello\.$/
    )
    expect(text(users[1])).toBe('/review src')
    expect(text(users[2])).toBe('Never mind, thanks.')
    const userItems = items(rows).filter((i) => i.type === 'UserMessage')
    expect((userItems[0].content as { text: string }[])[0].text).toBe(text(users[0]))
    const without = codexRollout(sample(), { threadId: 't', header: false, now: () => NOW }).rows
    const first = without.find((r) => r.type === 'response_item' && r.payload.role === 'user')!
    expect(text(first)).toBe('List the files here, then write hello.txt with the word hello.')
  })
  it('pairs every function_call with its output, in that order, under the same call id', () => {
    const calls = rows.filter(
      (r) => r.type === 'response_item' && r.payload.type === 'function_call'
    )
    expect(calls).toHaveLength(4)
    for (const call of calls) {
      const next = rows[call.ordinal + 1]
      expect(next.type).toBe('response_item')
      expect(payload(next)).toMatchObject({
        type: 'function_call_output',
        call_id: call.payload.call_id
      })
      expect(typeof call.payload.arguments).toBe('string')
      expect(() => JSON.parse(call.payload.arguments as string)).not.toThrow()
    }
    expect(calls.map((c) => c.payload.name)).toEqual(['Bash', 'Write', 'Read', 'Grep'])
    const grep = rows[calls[3].ordinal + 1]
    expect(grep.payload.output).toMatch(/no result was recorded/)
  })
  it('shows each call as the Codex item that matches it: a command, a file change, an MCP call', () => {
    const turnOne = items(rows).slice(0, 6)
    expect(turnOne.map((i) => i.type)).toEqual([
      'UserMessage',
      'AgentMessage',
      'CommandExecution',
      'FileChange',
      'McpToolCall',
      'AgentMessage'
    ])
    expect(turnOne[1]).toMatchObject({ phase: 'commentary' })
    expect(turnOne[5]).toMatchObject({ phase: 'final_answer' })
    expect(turnOne[2]).toEqual({
      type: 'CommandExecution',
      id: 'toolu_01',
      command: ['bash', '-lc', 'ls'],
      cwd: 'file:///Users/example/project',
      parsed_cmd: [],
      source: 'agent',
      status: 'completed',
      aggregated_output: 'README.md\nsrc\n',
      exit_code: 0
    })
    expect(turnOne[3]).toEqual({
      type: 'FileChange',
      id: 'toolu_02',
      changes: { '/Users/example/project/hello.txt': { type: 'add', content: 'hello\n' } },
      status: 'completed',
      stdout: 'File created successfully at: /Users/example/project/hello.txt'
    })
    expect(turnOne[4]).toEqual({
      type: 'McpToolCall',
      id: 'toolu_03',
      server: 'claude-code',
      tool: 'Read',
      arguments: { file_path: '/Users/example/project/hello.txt' },
      status: 'completed',
      result: { content: [{ type: 'text', text: '     1\thello' }] }
    })
  })
  it('marks a call the transcript never answered as failed, and the turn the person cut as aborted', () => {
    const grep = items(rows).find((i) => i.id === 'toolu_04')!
    expect(grep).toMatchObject({
      type: 'McpToolCall',
      tool: 'Grep',
      status: 'failed',
      error: { message: 'No result was recorded for this call' }
    })
    const aborted = rows.find((r) => r.payload.type === 'turn_aborted')!
    expect(payload(aborted)).toMatchObject({ reason: 'interrupted' })
    const secondStart = rows.filter((r) => r.payload.type === 'task_started')[1]
    expect(aborted.payload.turn_id).toBe(secondStart.payload.turn_id)
  })
  it('stamps every item_completed with the thread and its turn, and dates it', () => {
    const completed = rows.filter((r) => r.payload.type === 'item_completed')
    const turns = new Set(
      rows.filter((r) => r.payload.type === 'task_started').map((r) => r.payload.turn_id)
    )
    for (const r of completed) {
      expect(r.payload.thread_id).toBe('thread-1')
      expect(turns.has(r.payload.turn_id)).toBe(true)
      expect(typeof r.payload.completed_at_ms).toBe('number')
    }
  })
})

describe('mapping one call', () => {
  const call = (
    name: string,
    input: unknown,
    output: unknown,
    error?: boolean
  ): Record<string, unknown> =>
    codexItemFor(
      {
        call: { type: 'tool_call', id: 'c', name, input },
        result:
          output === null
            ? null
            : { type: 'tool_result', id: 'c', output, ...(error ? { error } : {}) }
      },
      '/w'
    )
  it('routes an MCP tool to its own server, a Codex item back to its kind, the rest to claude-code', () => {
    expect(call('mcp__clave__clave_notify', { title: 'x' }, 'ok')).toMatchObject({
      type: 'McpToolCall',
      server: 'clave',
      tool: 'clave_notify',
      arguments: { title: 'x' }
    })
    expect(call('WebFetch', { url: 'https://example.test' }, 'page')).toMatchObject({
      server: 'claude-code',
      tool: 'WebFetch'
    })
    expect(
      call('commandExecution', { command: ['ls', '-la'], cwd: '/here', exit_code: 2 }, 'out')
    ).toMatchObject({
      type: 'CommandExecution',
      command: ['ls', '-la'],
      cwd: 'file:///here',
      exit_code: 2,
      status: 'completed'
    })
    expect(call('clave/clave_focus', {}, 'ok')).toMatchObject({
      server: 'clave',
      tool: 'clave_focus'
    })
  })
  it('carries a failure as a failure', () => {
    expect(call('Bash', { command: 'false' }, 'boom', true)).toMatchObject({
      status: 'failed',
      exit_code: 1,
      aggregated_output: 'boom'
    })
    expect(
      call('Edit', { file_path: '/w/a', old_string: 'x', new_string: 'y' }, 'nope', true)
    ).toMatchObject({
      type: 'FileChange',
      status: 'failed',
      changes: { '/w/a': { type: 'update', unified_diff: '-x\n+y', move_path: null } }
    })
    expect(call('Read', { file_path: '/w/a' }, 'no such file', true)).toMatchObject({
      status: 'failed',
      error: { message: 'no such file' }
    })
  })
  it('reads a tool output however the provider shaped it', () => {
    expect(outputText('plain')).toBe('plain')
    expect(
      outputText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' }
      ])
    ).toBe('a\nb')
    expect(outputText([{ type: 'image', source: {} }])).toBe('[Image]')
    expect(outputText({ k: 1 })).toBe('{"k":1}')
    expect(outputText(undefined)).toBe('')
  })
})

describe('leaving out what is not the conversation', () => {
  it("drops a subagent's own events and a result with no call, and counts them", () => {
    const session: Session = {
      head: {
        provider: 'claude',
        id: 's',
        model: null,
        cwd: '/w',
        cliVersion: null,
        startedAt: NOW,
        endedAt: NOW,
        source: 'x'
      },
      items: [
        { event: { type: 'tool_result', id: 'orphan', output: 'x' }, at: NOW },
        { event: { type: 'user_message', text: 'go' }, at: NOW },
        {
          event: { type: 'tool_call', id: 'agent-1', name: 'Agent', input: { prompt: 'look' } },
          at: NOW
        },
        { event: { type: 'user_message', text: 'the subagent brief', parent: 'agent-1' }, at: NOW },
        {
          event: { type: 'assistant_text', delta: 'found', final: true, parent: 'agent-1' },
          at: NOW
        },
        { event: { type: 'tool_result', id: 'agent-1', output: 'found' }, at: NOW },
        { event: { type: 'tool_result', id: 'ghost', output: 'x' }, at: NOW },
        { event: { type: 'assistant_text', delta: 'done', final: true }, at: NOW }
      ]
    }
    const rollout = codexRollout(session, { threadId: 't', now: () => NOW })
    expect(rollout.dropped).toEqual({ subagent: 2, unmatchedResult: 1, beforeFirstMessage: 1 })
    expect(JSON.stringify(rollout.rows)).not.toContain('the subagent brief')
    expect(JSON.stringify(rollout.rows)).not.toContain('the subagent finding')
    expect(items(rollout.rows).map((i) => i.type)).toEqual([
      'UserMessage',
      'McpToolCall',
      'AgentMessage'
    ])
  })
})

describe('writing the file', () => {
  it('refuses a Codex version outside the pin before touching the disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-bridge-home-'))
    dirs.push(home)
    const refusal = writeCodex(sample(), { codexHome: home, codexVersion: '0.171.0' })
    await expect(refusal).rejects.toBeInstanceOf(UnsupportedVersionError)
    expect(readdirSync(home)).toEqual([])
  })
  it('writes the file where Codex looks, reads it back as the same conversation, and never overwrites it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-bridge-home-'))
    dirs.push(home)
    const written = await writeCodex(sample(), {
      codexHome: home,
      codexVersion: '0.167.0',
      threadId: '01a1c157-0000-7000-8000-000000000001',
      now: () => NOW
    })
    expect(written.path).toBe(join(home, written.relativePath))
    expect(existsSync(written.path)).toBe(true)
    expect(written.codexVersion).toBe('0.167.0')
    expect(payload(written.rows[0]).cli_version).toBe('0.167.0')
    expect(readdirSync(home)).toEqual(['sessions'])
    const back = readCodex(written.threadId, home)
    expect(back.head).toMatchObject({
      provider: 'codex',
      id: written.threadId,
      cwd: '/Users/example/project',
      model: 'gpt-5'
    })
    const said = back.items
      .map((i) => i.event)
      .filter((e) => e.type === 'user_message' || e.type === 'assistant_text')
      .map((e) => (e.type === 'user_message' ? `> ${e.text}` : `< ${e.delta}`))
    expect(said[0]).toMatch(/^> \[This conversation was converted from Claude Code/)
    expect(said.slice(1)).toEqual([
      '< Listing the folder first.',
      '< Done: the folder holds README.md and src, and hello.txt now says hello.',
      '> /review src',
      '> Never mind, thanks.',
      '< All right.'
    ])
    expect(
      back.items
        .filter((i) => i.event.type === 'tool_call')
        .map((i) => (i.event as { name: string }).name)
    ).toEqual(['commandExecution', 'fileChange', 'claude-code/Read', 'claude-code/Grep'])
    await expect(
      writeCodex(sample(), {
        codexHome: home,
        codexVersion: '0.167.0',
        threadId: written.threadId,
        now: () => NOW
      })
    ).rejects.toThrow(/Refusing to overwrite/)
  })
  it('refuses a session with nothing the person said', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-bridge-home-'))
    dirs.push(home)
    const empty: Session = {
      head: {
        provider: 'claude',
        id: 's',
        model: null,
        cwd: '/w',
        cliVersion: null,
        startedAt: null,
        endedAt: null,
        source: 'x'
      },
      items: [{ event: { type: 'assistant_text', delta: 'alone', final: true } }]
    }
    await expect(writeCodex(empty, { codexHome: home, codexVersion: '0.167.0' })).rejects.toThrow(
      /no message/
    )
    expect(readdirSync(home)).toEqual([])
  })
})
