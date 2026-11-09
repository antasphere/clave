import { describe, expect, it } from 'vitest'
import type { HistoryItem as BridgeHistoryItem } from '@clave/session-bridge/ir'
import { SessionEventSchema } from '../../../shared/session-model'
import { CLI_WRAPPER_TAGS, isCliWrapper, toHistoryItems } from './bridge-history'

const said = (text: string, at?: number): BridgeHistoryItem => ({
  event: { type: 'user_message', text },
  ...(at !== undefined ? { at } : {})
})

describe("the bridge's replay as the chat's history (PRDCT-4301)", () => {
  it('keeps a message that merely starts with <, and drops a CLI row by its exact tag', () => {
    const items = toHistoryItems(
      [
        said('<div>pasted</div> what is this?'),
        said('<local-command-stdout>ok</local-command-stdout>'),
        said('  <task-notification>done</task-notification>'),
        said('<3'),
        said('Caveat: I mean it')
      ],
      { wrappers: 'drop' }
    ).map((i) => (i.event as { text: string }).text)
    expect(items).toEqual(['<div>pasted</div> what is this?', '<3', 'Caveat: I mean it'])
  })
  it('keeps every message when nothing asks for the drop (the Codex road)', () => {
    const items = toHistoryItems([said('<local-command-stdout>ok</local-command-stdout>')])
    expect(items).toHaveLength(1)
  })
  it('names the window off the model when the bridge left it unknown, and keeps the bridge’s own', () => {
    const items = toHistoryItems([
      { event: { type: 'context_usage', used: 10, window: null, model: 'claude-opus-5-5' } },
      {
        event: { type: 'context_usage', used: 11, window: 1_000_000, model: 'claude-fable-5-1[1m]' }
      },
      { event: { type: 'context_usage', used: 12, window: null, model: 'gpt-5.5' } },
      { event: { type: 'context_usage', used: 13, window: null } }
    ]).map((i) => i.event)
    expect(items).toEqual([
      { type: 'context_usage', used: 10, window: 1_000_000 },
      { type: 'context_usage', used: 11, window: 1_000_000 },
      { type: 'context_usage', used: 12, window: null },
      { type: 'context_usage', used: 13, window: null }
    ])
  })
  it('carries the time, the form marker, the parent and the error flag through, and nothing else', () => {
    const items = toHistoryItems([
      { event: { type: 'user_message', text: 'form', form: 'clave:1', parent: 'p' }, at: 5 },
      { event: { type: 'tool_call', id: 't', name: 'Bash', input: { command: 'ls' } }, at: 6 },
      { event: { type: 'tool_result', id: 't', output: 'x', error: true } },
      { event: { type: 'assistant_text', delta: 'ok', final: true } },
      { event: { type: 'turn_interrupted' } },
      { event: { type: 'session_meta', model: 'm', providerSessionId: null } }
    ])
    expect(items).toEqual([
      { event: { type: 'user_message', text: 'form', form: 'clave:1', parent: 'p' }, at: 5 },
      { event: { type: 'tool_call', id: 't', name: 'Bash', input: { command: 'ls' } }, at: 6 },
      { event: { type: 'tool_result', id: 't', output: 'x', error: true } },
      { event: { type: 'assistant_text', delta: 'ok', final: true } },
      { event: { type: 'turn_interrupted' } },
      { event: { type: 'session_meta', model: 'm', providerSessionId: null } }
    ])
    for (const { event } of items) expect(SessionEventSchema.safeParse(event).success).toBe(true)
  })
  it('knows the CLI’s rows by tag, not by first character', () => {
    for (const tag of CLI_WRAPPER_TAGS) expect(isCliWrapper(`${tag}body`)).toBe(true)
    expect(isCliWrapper('<local-command-stdout-ish>')).toBe(false)
    expect(isCliWrapper('<b>bold</b>')).toBe(false)
    expect(isCliWrapper('Caveat: mine')).toBe(false)
  })
})
