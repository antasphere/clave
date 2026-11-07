import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tempDataDir } from './ports/testing'
import { fileTerminalJournal, terminalJournal } from './terminal-journal'

describe('the terminal journal', () => {
  it('appends one line per spawn and per write, the spawn without the restart’s resent message', () => {
    const file = path.join(tempDataDir(), 'journal.jsonl')
    const journal = fileTerminalJournal(file)
    journal.spawn('/work', {
      claudeMode: true,
      initialPrompt: 'hello @root_path',
      initialInput: { type: 'user_message', text: 'never journaled' }
    })
    journal.spawn('/other', undefined)
    journal.write('s1', 'ls\r')
    const lines = fs
      .readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({
      kind: 'spawn',
      cwd: '/work',
      options: { claudeMode: true, initialPrompt: 'hello @root_path' }
    })
    expect(lines[0].options).not.toHaveProperty('initialInput')
    expect(lines[1]).toMatchObject({ kind: 'spawn', cwd: '/other', options: {} })
    expect(lines[2]).toMatchObject({ kind: 'write', id: 's1', data: 'ls\r' })
    expect(typeof lines[0].t).toBe('number')
  })

  it('does not exist outside test mode: this process carries no --test-no-activate', () => {
    // A spawn’s options carry the prompt; the file must never be written by
    // default. The flag is read off process.argv at import, and vitest’s has
    // none, so the manager gets no journal here whatever ports are installed.
    expect(process.argv.includes('--test-no-activate')).toBe(false)
    expect(terminalJournal()).toBeNull()
    expect(terminalJournal()).toBeNull()
  })

  it('a file that cannot be written breaks nothing', () => {
    const journal = fileTerminalJournal('/nonexistent-dir/for/the/journal.jsonl')
    expect(() => journal.spawn('/work', {})).not.toThrow()
    expect(() => journal.write('s', 'x')).not.toThrow()
  })
})
