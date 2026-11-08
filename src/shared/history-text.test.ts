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
