import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStream } from '../../shared/session-model'
import { serverHistory } from './server-history'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const event = (value: Extract<SessionStream, { kind: 'event' }>['event']): SessionStream => ({
  kind: 'event',
  event: value
})

describe('the server’s saved history of a tab', () => {
  it('keeps the conversation, never the live state: what waits for the agent included (PRDCT-4566)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'server-history-'))
    dirs.push(dir)
    const history = serverHistory(dir)
    history.record('tab-1', event({ type: 'user_message', text: 'first' }))
    history.record('tab-1', event({ type: 'state_change', state: 'working' }))
    history.record(
      'tab-1',
      event({
        type: 'waiting_messages',
        messages: [],
        takes: 'turn',
        returned: { why: 'stopped', messages: [{ id: 'w1', text: 'second' }] }
      })
    )
    history.record('tab-1', event({ type: 'background_tasks', tasks: [] }))
    history.record('tab-1', event({ type: 'assistant_text', delta: 'Done.', final: true }))
    expect(history.read('tab-1').items.map((item) => item.event.type)).toEqual([
      'user_message',
      'assistant_text'
    ])
    // Read back from disk, as a server started again reads it.
    expect(
      serverHistory(dir)
        .read('tab-1')
        .items.map((item) => item.event.type)
    ).toEqual(['user_message', 'assistant_text'])
  })
})
