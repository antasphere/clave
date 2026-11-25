import { describe, expect, it } from 'vitest'
import { historyLines, readHistory } from './history-text'
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

/** A chat whose agent ends its turns on a status card (PRDCT-5166). */
describe('a chat read with its status cards', () => {
  const card = [
    '```clave-status',
    'doing: the export',
    'where: the button works, the file name is left',
    'decide: keep the date in the name? I would.',
    'next: nothing',
    '```'
  ].join('\n')
  const answer = (text: string): HistoryItem =>
    item({ type: 'assistant_text', delta: text, final: true })

  it('writes the words on the Agent line and the card as indented lines under it', () => {
    const read = readHistory([
      item({ type: 'user_message', text: 'go' }),
      answer(`Done: the export runs.\n\n${card}`)
    ])
    expect(read.lines).toEqual([
      'You: go',
      'Agent: Done: the export runs.',
      '  Doing: the export',
      '  Where: the button works, the file name is left',
      '  To decide: keep the date in the name? I would.',
      '  Next: nothing'
    ])
    expect(read.lines.join('\n')).not.toContain('clave-status')
    expect(read.status).toEqual({
      doing: 'the export',
      where: 'the button works, the file name is left',
      decide: ['keep the date in the name? I would.'],
      next: null,
      needsYou: true,
      answered: false
    })
  })

  it('writes a message that is a status alone as an empty Agent line and the card under it', () => {
    const read = readHistory([answer('```clave-status\nwhere: all green\nnext: try it\n```')])
    expect(read.lines).toEqual(['Agent:', '  Where: all green', '  Next: try it'])
    expect(read.status).toMatchObject({ where: 'all green', next: 'try it', needsYou: true })
  })

  it('leaves a block that is not the message’s ending as written, and reads no status from it', () => {
    const text = `Before.\n\n${card}\n\nAnd after the block.`
    const read = readHistory([answer(text)])
    expect(read.lines).toEqual([`Agent: ${text}`])
    expect(read.status).toBeNull()
  })

  it('ignores a sub-agent’s message, card and all', () => {
    const read = readHistory([
      item({ type: 'assistant_text', delta: `sub work\n\n${card}`, final: true, parent: 'sub-1' })
    ])
    expect(read).toEqual({ lines: [], status: null })
  })

  it('gives the status of the last agent message only: none when the last wrote none', () => {
    const read = readHistory([
      answer(`First.\n\n${card}`),
      item({ type: 'user_message', text: 'and now?' }),
      answer('Plain answer, no card.')
    ])
    expect(read.lines.slice(-1)).toEqual(['Agent: Plain answer, no card.'])
    expect(read.status).toBeNull()
  })

  it('marks the status answered once the person has written since, and a tool call does not', () => {
    const ended = [answer(`Ready.\n\n${card}`)]
    expect(
      readHistory([...ended, item({ type: 'tool_call', id: 't', name: 'Read', input: {} })]).status
        ?.answered
    ).toBe(false)
    const answered = readHistory([...ended, item({ type: 'user_message', text: 'yes' })])
    expect(answered.status).toMatchObject({ doing: 'the export', answered: true })
    // A message of a sub-agent is not the person writing.
    expect(
      readHistory([...ended, item({ type: 'user_message', text: 'sub', parent: 'sub-1' })]).status
        ?.answered
    ).toBe(false)
  })

  it('says a card asking nothing does not need the person', () => {
    const read = readHistory([
      answer('Shipped.\n\n```clave-status\nwhere: merged\nnext: nothing\n```')
    ])
    expect(read.status).toMatchObject({ needsYou: false, next: null, decide: [] })
    expect(
      historyLines([answer('Shipped.\n\n```clave-status\nwhere: merged\nnext: nothing\n```')])
    ).toEqual(['Agent: Shipped.', '  Where: merged', '  Next: nothing'])
  })
})
