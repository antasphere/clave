import { describe, expect, it } from 'vitest'
import { historyLines } from './history-text'
import type { HistoryItem } from './session-model'

/** A chat's history as the lines an agent reads (PRDCT-4199). */
const item = (event: HistoryItem['event']): HistoryItem => ({ event, at: 1 })

describe('historyLines', () => {
  it('writes one line per message, answer, tool call, question and error, oldest first', () => {
    expect(
      historyLines([
        item({ type: 'user_message', text: 'first message' }),
        item({ type: 'state_change', state: 'working' }),
        item({ type: 'assistant_text', delta: 'stub ', final: false }),
        item({ type: 'assistant_text', delta: 'heard', final: true }),
        item({ type: 'tool_call', id: 't1', name: 'Read', input: {} }),
        item({ type: 'tool_result', id: 't1', output: 'x', error: false }),
        item({
          type: 'permission_request',
          id: 'p',
          description: 'Run it?',
          options: [{ id: 'yes', label: 'Yes' }]
        }),
        item({ type: 'error', message: 'boom', fatal: false }),
        item({ type: 'session_meta', model: 'opus', providerSessionId: null })
      ])
    ).toEqual([
      'You: first message',
      'Agent: stub heard',
      'Tool: Read',
      'Asked: Run it?',
      'Error: boom'
    ])
  })
  // PRDCT-4566: a quiet notice reports no failure (another tab's message left
  // unsent): its words alone, never as an error; a failure keeps its Error.
  it('writes a quiet notice as its words alone, a failure as an error', () => {
    expect(
      historyLines([
        item({ type: 'user_message', text: 'stop now' }),
        item({
          type: 'error',
          message: 'A message from Lane B was not sent.',
          fatal: false,
          quiet: true
        }),
        item({ type: 'error', message: 'Pi stopped during the turn (exit code 137)', fatal: false })
      ])
    ).toEqual([
      'You: stop now',
      'A message from Lane B was not sent.',
      'Error: Pi stopped during the turn (exit code 137)'
    ])
  })
  it('closes an answer still open at the end, drops an empty one, and skips a subagent’s lines', () => {
    expect(
      historyLines([
        item({ type: 'user_message', text: 'go', parent: 'sub-1' }),
        item({ type: 'assistant_text', delta: '', final: true }),
        item({ type: 'assistant_text', delta: 'still writing', final: false })
      ])
    ).toEqual(['Agent: still writing'])
    expect(historyLines([])).toEqual([])
    // A message that is only files says so, rather than an empty line.
    expect(
      historyLines([item({ type: 'user_message', text: '', attachments: [{} as never] })])
    ).toEqual(['You: [1 attachment]'])
  })
})
