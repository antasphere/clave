import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ConversationCache, parseConversation } from './conversation'

const j = (v: unknown): string => JSON.stringify(v)

const user = (text: string, ts?: string): string =>
  j({ type: 'user', timestamp: ts, message: { content: text } })
const userBlocks = (text: string, ts?: string): string =>
  j({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text }] } })
const assistant = (text: string): string =>
  j({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('parseConversation', () => {
  it('folds one turn per human message, reply from the final agent text', () => {
    const turns = parseConversation([
      user('Fix the login bug', '2026-08-25T10:00:00.000Z'),
      assistant('Let me look at the guard first.'),
      j({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] }
      }),
      j({
        type: 'user',
        toolUseResult: true,
        message: { content: [{ type: 'tool_result', content: 'file contents' }] }
      }),
      assistant('Fixed — the guard now rejects expired tokens.\nDetails below.'),
      userBlocks('Now add a test', '2026-08-25T10:05:00.000Z'),
      assistant('Test added and green.')
    ])
    expect(turns).toEqual([
      {
        ts: '2026-08-25T10:00:00.000Z',
        userText: 'Fix the login bug',
        replyHead: 'Fixed — the guard now rejects expired tokens.'
      },
      {
        ts: '2026-08-25T10:05:00.000Z',
        userText: 'Now add a test',
        replyHead: 'Test added and green.'
      }
    ])
  })

  it('a turn the agent has not answered yet carries a null replyHead', () => {
    const turns = parseConversation([user('Anything there?')])
    expect(turns).toEqual([{ ts: null, userText: 'Anything there?', replyHead: null }])
  })

  it('injected context, sidechains, meta and thinking are not conversation', () => {
    const turns = parseConversation([
      j({ type: 'user', message: { content: '<system-reminder>noise</system-reminder>' } }),
      j({ type: 'user', message: { content: 'Caveat: injected preamble' } }),
      user('Real question'),
      j({
        type: 'assistant',
        isSidechain: true,
        message: { content: [{ type: 'text', text: 'subagent talk' }] }
      }),
      j({ type: 'user', isMeta: true, message: { content: 'meta note' } }),
      j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }] } }),
      assistant('The answer.')
    ])
    expect(turns).toEqual([{ ts: null, userText: 'Real question', replyHead: 'The answer.' }])
  })

  it('agent text before any human turn is dropped, not attached backwards', () => {
    const turns = parseConversation([assistant('Hello, orphan text'), user('First real message')])
    expect(turns).toEqual([{ ts: null, userText: 'First real message', replyHead: null }])
  })

  it('caps runaway texts and skips unparseable lines', () => {
    const turns = parseConversation([
      'not json at all',
      user('x'.repeat(9000)),
      assistant('y'.repeat(9000))
    ])
    expect(turns[0].userText.length).toBe(4000)
    expect(turns[0].replyHead!.length).toBe(300)
  })
})

describe('ConversationCache', () => {
  const tmpFile = (): string =>
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clave-conv-')), 't.jsonl')

  it('a missing file is exists:false; appended turns arrive incrementally', () => {
    const cache = new ConversationCache()
    const file = tmpFile()
    expect(cache.read(file)).toEqual({ exists: false, turns: [] })

    fs.writeFileSync(file, user('First') + '\n' + assistant('One.') + '\n')
    expect(cache.read(file).turns).toEqual([{ ts: null, userText: 'First', replyHead: 'One.' }])

    fs.appendFileSync(file, user('Second') + '\n')
    const turns = cache.read(file).turns
    expect(turns.length).toBe(2)
    expect(turns[1]).toEqual({ ts: null, userText: 'Second', replyHead: null })
  })

  it('a later agent text updates the open turn across reads', () => {
    const cache = new ConversationCache()
    const file = tmpFile()
    fs.writeFileSync(file, user('Q') + '\n' + assistant('Looking…') + '\n')
    expect(cache.read(file).turns[0].replyHead).toBe('Looking…')
    fs.appendFileSync(file, assistant('Found it: the cache key was stale.') + '\n')
    expect(cache.read(file).turns[0].replyHead).toBe('Found it: the cache key was stale.')
  })

  it('a partial trailing line is left for the next read', () => {
    const cache = new ConversationCache()
    const file = tmpFile()
    const second = user('Two')
    fs.writeFileSync(file, user('One') + '\n' + second.slice(0, 10))
    expect(cache.read(file).turns.length).toBe(1)
    fs.appendFileSync(file, second.slice(10) + '\n')
    const turns = cache.read(file).turns
    expect(turns.length).toBe(2)
    expect(turns[1].userText).toBe('Two')
  })

  it('a file that shrank is re-read from zero', () => {
    const cache = new ConversationCache()
    const file = tmpFile()
    fs.writeFileSync(file, user('Old one') + '\n' + user('Old two') + '\n')
    expect(cache.read(file).turns.length).toBe(2)
    fs.writeFileSync(file, user('Fresh') + '\n')
    expect(cache.read(file).turns).toEqual([{ ts: null, userText: 'Fresh', replyHead: null }])
  })
})
