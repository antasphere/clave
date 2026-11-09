import { describe, expect, it } from 'vitest'
import {
  cutTranscript,
  editedFiles,
  handoffMessage,
  transcriptFileName,
  transcriptMarkdown
} from './export'
import type { Entry } from './reducer'

const at = (h: number, m: number): number => new Date(2026, 10, 8, h, m).getTime()
const meta = {
  title: 'Fix the composer',
  agent: 'Claude',
  cwd: '/work/clave',
  model: 'claude-opus-5-5',
  exportedAt: new Date(2026, 10, 8, 15, 4)
}

describe('transcriptMarkdown', () => {
  it('writes each speaker once per turn, tools as one list, answers by label', () => {
    const entries: Entry[] = [
      { kind: 'user', text: 'Why is the border cut?', final: true, at: at(14, 2) },
      { kind: 'assistant', text: 'Let me look.', final: true, at: at(14, 2) },
      {
        kind: 'tool',
        id: 't1',
        name: 'Read',
        input: { file_path: '/work/clave/system.css' },
        complete: true,
        at: at(14, 3)
      },
      {
        kind: 'tool',
        id: 't2',
        name: 'Bash',
        input: { command: 'npm test' },
        complete: true,
        failed: true,
        at: at(14, 3)
      },
      {
        kind: 'permission',
        request: {
          type: 'permission_request',
          id: 'p1',
          description: 'Run npm test?',
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' }
          ]
        },
        answer: 'allow',
        at: at(14, 3)
      },
      { kind: 'assistant', text: 'The fade covers it.', final: true, at: at(14, 4) },
      { kind: 'user', text: 'Taken back', final: true, at: at(14, 5), withdrawn: true },
      { kind: 'error', message: 'socket closed', at: at(14, 6) }
    ]
    const md = transcriptMarkdown(entries, meta)
    expect(md).toContain('# Fix the composer')
    expect(md).toContain('Claude · claude-opus-5-5 · `/work/clave` · exported 2026-11-08 15:04')
    expect(md.match(/^## Claude/gm)).toHaveLength(1)
    expect(md.match(/^## You · 14:02/gm)).toHaveLength(1)
    expect(md).toContain('Let me look.')
    expect(md).toContain('The fade covers it.')
    expect(md).toMatch(/^- .*`\/work\/clave\/system\.css`$/m)
    expect(md).toMatch(/^- .*`npm test` _\(failed\)_$/m)
    expect(md).toContain('> **Asked:** Run npm test?\n> **Answer:** Allow')
    expect(md).toContain('> **Error:** socket closed')
    expect(md).not.toContain('Taken back')
    // The answer comes before the tools in the order they happened.
    expect(md.indexOf('Let me look.')).toBeLessThan(md.indexOf('npm test'))
    expect(md.indexOf('npm test')).toBeLessThan(md.indexOf('The fade covers it.'))
  })

  it('names attachments and fences a target holding backticks', () => {
    const entries: Entry[] = [
      {
        kind: 'user',
        text: 'See this',
        final: true,
        at: at(9, 0),
        attachments: [
          {
            id: 'a',
            label: 'shot',
            path: '/tmp/shot.png',
            name: 'shot.png',
            mimeType: 'image/png',
            size: 1,
            delivery: 'image'
          }
        ]
      },
      {
        kind: 'tool',
        id: 't',
        name: 'Bash',
        input: { command: 'echo `date`' },
        complete: true,
        at: at(9, 1)
      }
    ]
    const md = transcriptMarkdown(entries, meta)
    expect(md).toContain('_Attached: `shot.png`_')
    expect(md).toContain('`` echo `date` ``')
  })
})

describe('transcriptFileName', () => {
  it('keeps a name any disk accepts', () => {
    expect(transcriptFileName('a/b: c?', new Date(2026, 0, 2))).toBe('a b c 2026-01-02.md')
    expect(transcriptFileName('   ', new Date(2026, 0, 2))).toBe('Session 2026-01-02.md')
  })
})

describe('the handoff message of a provider switch (PRDCT-4300)', () => {
  const entries: Entry[] = [
    { kind: 'user', text: 'Rename the chip', final: true, at: at(9, 0) },
    { kind: 'assistant', text: 'Looking at the footer.', final: true, at: at(9, 0) },
    {
      kind: 'tool',
      id: 't1',
      name: 'Read',
      input: { file_path: '/work/clave/ModelMenu.tsx' },
      output: 'export function ModelMenu',
      complete: true,
      at: at(9, 1)
    },
    {
      kind: 'tool',
      id: 't2',
      name: 'Edit',
      input: { file_path: '/work/clave/ModelMenu.tsx', old_string: 'a', new_string: 'b' },
      output: 'ok',
      complete: true,
      at: at(9, 1)
    },
    { kind: 'assistant', text: 'Renamed.', final: true, at: at(9, 2) },
    { kind: 'user', text: 'Now the test', final: true, at: at(9, 3) },
    {
      kind: 'tool',
      id: 't3',
      name: 'Bash',
      input: { command: 'npx vitest run models.test.ts' },
      output: ' ✓ 12 tests passed\n' + 'x'.repeat(5000),
      complete: true,
      at: at(9, 4)
    },
    {
      kind: 'tool',
      id: 't4',
      name: 'Write',
      input: { file_path: '/work/clave/models.test.ts', content: '…' },
      output: 'File created',
      complete: true,
      at: at(9, 4)
    },
    { kind: 'assistant', text: 'Green.', final: true, at: at(9, 5) }
  ]
  const extras = {
    from: 'Claude',
    files: editedFiles(entries),
    diffStat: ' ModelMenu.tsx | 2 +-\n 1 file changed',
    tapePath: '/Users/me/Library/Application Support/Clave/handoffs/s1.md',
    budgetChars: 100_000
  }
  it('lists the files the agent edited or created, each once', () => {
    expect(editedFiles(entries)).toEqual([
      '/work/clave/ModelMenu.tsx',
      '/work/clave/models.test.ts'
    ])
  })
  it("writes the last stretch's tool outputs only, each cut to the limit", () => {
    const md = transcriptMarkdown(entries, meta, { lastStretchOutputs: true, outputChars: 100 })
    expect(md).not.toContain('export function ModelMenu')
    expect(md).toContain('✓ 12 tests passed')
    expect(md).toContain('more characters)')
    expect(md).toContain('File created')
    expect(transcriptMarkdown(entries, meta)).not.toContain('✓ 12 tests passed')
  })
  it('opens with the header and what the move is, carries the note, the conversation, the files, the diff and the tape', () => {
    const md = handoffMessage(entries, meta, {
      ...extras,
      note: 'We renamed the chip; the test is next.'
    })
    expect(md.startsWith('# Continued from Claude · handoff\n')).toBe(true)
    expect(md).toContain('You are reading a transcript of it, not continuing it')
    expect(md).toContain('## Handoff note from Claude\n\nWe renamed the chip; the test is next.')
    expect(md).toContain('## The conversation so far')
    expect(md).toContain('Rename the chip')
    expect(md).toContain('Green.')
    expect(md).toContain('- `/work/clave/ModelMenu.tsx`')
    expect(md).toContain('## Working tree (git diff --stat)\n\n```\n ModelMenu.tsx | 2 +-')
    expect(md).toContain('is in `/Users/me/Library/Application Support/Clave/handoffs/s1.md`.')
    // No note asked: no note section.
    expect(handoffMessage(entries, meta, extras)).not.toContain('## Handoff note')
  })
  it('cuts the oldest turns to the budget, keeps the first turn and the newest, and says where the rest is', () => {
    const long: Entry[] = Array.from({ length: 40 }, (_, i) => [
      {
        kind: 'user' as const,
        text: `question ${i} ${'words '.repeat(40)}`,
        final: true,
        at: at(10, i)
      },
      {
        kind: 'assistant' as const,
        text: `answer ${i} ${'words '.repeat(40)}`,
        final: true,
        at: at(10, i)
      }
    ]).flat()
    const md = handoffMessage(long, meta, { ...extras, budgetChars: 6000 })
    expect(md.length).toBeLessThan(6500)
    expect(md).toContain('question 0 ')
    expect(md).toContain('question 39 ')
    expect(md).not.toContain('question 20 ')
    expect(md).toMatch(/## … \d+ earlier turns left out for room; the full conversation is in/)
  })
  it('cutTranscript leaves a transcript within budget whole', () => {
    const md = transcriptMarkdown(entries, meta)
    expect(cutTranscript(md, md.length, '/tape.md')).toBe(md)
  })
})

describe('cutTranscript on one long run of a single speaker', () => {
  it('keeps the newest end and says the start was left out', () => {
    const md = '## You · 10:00\n\n' + 'line\n'.repeat(2000)
    const cut = cutTranscript(md, 3000, '/tape.md')
    expect(cut.length).toBeLessThanOrEqual(3000)
    expect(
      cut.startsWith(
        '## … the start of the conversation left out for room; the full conversation is in /tape.md'
      )
    ).toBe(true)
  })
})
