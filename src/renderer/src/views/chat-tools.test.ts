import { describe, expect, it } from 'vitest'
import type { Entry } from '../../../../plugins/chat-view/src/reducer'
import {
  describeTool,
  describeToolHead,
  failureCount,
  groupEntries,
  groupStatus,
  PREVIEW_CHARS,
  PREVIEW_LINES,
  toolGroupSummary,
  toolPreview,
  safeJson,
  content,
  visibleEntries,
  type ToolEntry
} from '../../../../plugins/chat-view/src/tools'

/* The grouping, the summary and the preview decided without a DOM. The rule
   these tests exist to hold is that a run of tools is one step of the agent's
   work: a MESSAGE ends it, a permission card does not. */

const tool = (over: Partial<ToolEntry> & { id: string }): ToolEntry => ({
  kind: 'tool',
  name: 'Read',
  input: {},
  complete: true,
  at: 0,
  ...over
})
const user = (text: string): Entry => ({ kind: 'user', text, final: true, at: 0 })
const assistant = (text: string): Entry => ({ kind: 'assistant', text, final: true, at: 0 })
const permission = (id: string): Entry => ({
  kind: 'permission',
  request: { type: 'permission_request', id, description: 'Allow?', options: [] },
  at: 0
})

describe('groupEntries', () => {
  it('folds a run of consecutive tools into one group keyed by its first tool', () => {
    const blocks = groupEntries([
      user('go'),
      tool({ id: 'a' }),
      tool({ id: 'b' }),
      tool({ id: 'c' }),
      assistant('done')
    ])
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'tool-group', 'assistant'])
    const group = blocks[1]
    expect(group.kind === 'tool-group' && group.id).toBe('a')
    expect(group.kind === 'tool-group' && group.tools.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('does NOT break a run on a permission card — the approval is part of the step', () => {
    const blocks = groupEntries([tool({ id: 'a' }), permission('p1'), tool({ id: 'b' })])
    expect(blocks.map((b) => b.kind)).toEqual(['tool-group', 'permission'])
    const group = blocks[0]
    expect(group.kind === 'tool-group' && group.tools.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('does not break a run on an error entry either', () => {
    const blocks = groupEntries([
      tool({ id: 'a' }),
      { kind: 'error', message: 'transient', at: 0 },
      tool({ id: 'b' })
    ])
    const group = blocks.find((b) => b.kind === 'tool-group')
    expect(group?.kind === 'tool-group' && group.tools).toHaveLength(2)
  })

  it('DOES break a run on a user message and on an assistant message', () => {
    for (const message of [user('next'), assistant('thinking')]) {
      const blocks = groupEntries([tool({ id: 'a' }), message, tool({ id: 'b' })])
      expect(blocks.filter((b) => b.kind === 'tool-group')).toHaveLength(2)
      expect(blocks.map((b) => b.kind)).toEqual(['tool-group', message.kind, 'tool-group'])
    }
  })

  it('keeps entries that are not tools untouched and in order', () => {
    const entries = [user('a'), assistant('b'), permission('p')]
    expect(groupEntries(entries)).toEqual(entries)
  })

  it('returns nothing for no entries', () => {
    expect(groupEntries([])).toEqual([])
  })
})

describe('groupStatus and failureCount', () => {
  it('is running while any tool is incomplete, even beside a failure', () => {
    const tools = [
      tool({ id: 'a', complete: true, failed: true }),
      tool({ id: 'b', complete: false })
    ]
    expect(groupStatus(tools)).toBe('running')
    expect(failureCount(tools)).toBe(1)
  })
  it('is failed once everything finished and one failed', () => {
    expect(groupStatus([tool({ id: 'a' }), tool({ id: 'b', failed: true })])).toBe('failed')
  })
  it('is complete when no adapter flagged a failure', () => {
    expect(groupStatus([tool({ id: 'a' }), tool({ id: 'b' })])).toBe('complete')
    expect(failureCount([tool({ id: 'a' }), tool({ id: 'b' })])).toBe(0)
  })
  it('treats an absent flag as not-failed, never guessing from the output', () => {
    const looksBad = tool({ id: 'a', output: 'Error: no such file\nError: again' })
    expect(groupStatus([looksBad])).toBe('complete')
    expect(failureCount([looksBad])).toBe(0)
  })
})

describe('describeTool', () => {
  it('names the kind from the tool name, however it is spelled', () => {
    expect(describeTool(tool({ id: 'a', name: 'Read' })).kind).toBe('read')
    expect(describeTool(tool({ id: 'a', name: 'file_change' })).kind).toBe('edit')
    expect(describeTool(tool({ id: 'a', name: 'commandExecution' })).kind).toBe('command')
    expect(describeTool(tool({ id: 'a', name: 'Grep' })).kind).toBe('search')
    expect(describeTool(tool({ id: 'a', name: 'Sparkle' })).kind).toBe('other')
  })
  it('labels an unknown tool with its own name rather than "other"', () => {
    expect(describeTool(tool({ id: 'a', name: 'Sparkle' })).label).toBe('Sparkle')
  })
  it('takes the target a human recognises the call by, per kind', () => {
    expect(
      describeTool(tool({ id: 'a', name: 'Read', input: { file_path: '/x.ts' } })).target
    ).toBe('/x.ts')
    expect(
      describeTool(tool({ id: 'a', name: 'Bash', input: { command: 'npm test' } })).target
    ).toBe('npm test')
    expect(
      describeTool(tool({ id: 'a', name: 'Grep', input: { pattern: 'TODO', path: 'src' } })).target
    ).toBe('TODO')
  })
  it('reads the line range of a Read as its detail', () => {
    expect(
      describeTool(tool({ id: 'a', input: { file_path: '/x', offset: 10, limit: 5 } })).detail
    ).toBe('Lines 10–14')
  })
  it('reads a shell exit code out of the output as its detail', () => {
    const shell = tool({ id: 'a', name: 'Bash', input: { command: 'ls' }, output: { exitCode: 2 } })
    expect(describeTool(shell).detail).toBe('Exit 2')
  })
  it('shows the output as a section once the call completed, and not before', () => {
    const pending = tool({ id: 'a', complete: false, input: { file_path: '/x' }, output: 'early' })
    expect(describeTool(pending).sections).toHaveLength(0)
    const done = tool({ id: 'a', complete: true, input: { file_path: '/x' }, output: 'body' })
    expect(done && describeTool(done).sections).toEqual([{ label: 'Content', text: 'body' }])
  })
  it('renders content blocks as text and anything else as readable JSON', () => {
    const blocks = tool({
      id: 'a',
      input: { file_path: '/x' },
      output: [{ text: 'one' }, { text: 'two' }]
    })
    expect(describeTool(blocks).sections[0].text).toBe('one\ntwo')
    const odd = tool({ id: 'a', input: { file_path: '/x' }, output: { shape: [1, 2] } })
    expect(describeTool(odd).sections[0].text).toContain('"shape"')
  })
})

describe('toolGroupSummary', () => {
  it('names a lone tool by its target rather than counting it', () => {
    expect(toolGroupSummary([tool({ id: 'a', name: 'Read', input: { file_path: '/x.ts' } })])).toBe(
      'Read · /x.ts'
    )
  })
  it('counts DISTINCT files for reads and edits', () => {
    const tools = [
      tool({ id: 'a', name: 'Read', input: { file_path: '/x' } }),
      tool({ id: 'b', name: 'Read', input: { file_path: '/y' } }),
      tool({ id: 'c', name: 'Read', input: { file_path: '/x' } })
    ]
    expect(toolGroupSummary(tools)).toBe('Read 2 files')
  })
  it('counts CALLS for commands and searches, and joins kinds in order', () => {
    const tools = [
      tool({ id: 'a', name: 'Read', input: { file_path: '/x' } }),
      tool({ id: 'b', name: 'Read', input: { file_path: '/y' } }),
      tool({ id: 'c', name: 'Read', input: { file_path: '/z' } }),
      tool({ id: 'd', name: 'Bash', input: { command: 'npm test' } })
    ]
    expect(toolGroupSummary(tools)).toBe('Read 3 files · Ran 1 command')
    expect(
      toolGroupSummary([
        tool({ id: 'a', name: 'Grep', input: { pattern: 'x' } }),
        tool({ id: 'b', name: 'Grep', input: { pattern: 'y' } })
      ])
    ).toBe('Searched twice')
  })
  it('will not claim N files unless EVERY read named one', () => {
    const tools = [
      tool({ id: 'a', name: 'Read', input: { file_path: '/x' } }),
      ...['b', 'c', 'd', 'e'].map((id) => tool({ id, name: 'Read', input: {} }))
    ]
    expect(toolGroupSummary(tools)).toBe('Read 5 times')
  })
  it('falls back to a count when a read carries no recognisable target', () => {
    expect(
      toolGroupSummary([
        tool({ id: 'a', name: 'Read', input: {} }),
        tool({ id: 'b', name: 'Read', input: {} })
      ])
    ).toBe('Read twice')
  })
  it('keeps two different unknown tools apart instead of merging them', () => {
    expect(
      toolGroupSummary([
        tool({ id: 'a', name: 'Sparkle', input: {} }),
        tool({ id: 'b', name: 'Sparkle', input: {} }),
        tool({ id: 'c', name: 'Twinkle', input: {} })
      ])
    ).toBe('Sparkle × 2 · Twinkle × 1')
  })
  it('says nothing for an empty run', () => {
    expect(toolGroupSummary([])).toBe('')
  })
})

describe('a target for every tool, not only the file-shaped ones', () => {
  it('names a WebFetch by its url and a Task by its description', () => {
    expect(
      describeTool(tool({ id: 'a', name: 'WebFetch', input: { url: 'https://example.com/docs' } }))
        .target
    ).toBe('https://example.com/docs')
    expect(
      describeTool(tool({ id: 'a', name: 'Task', input: { description: 'find the seam' } })).target
    ).toBe('find the seam')
  })
  it('falls back to the first string an unknown input carries', () => {
    expect(
      describeTool(tool({ id: 'a', name: 'mcp__linear__list', input: { teamId: 'TEAM-7' } })).target
    ).toBe('TEAM-7')
  })
  it('reads argv sent as an array as one command line', () => {
    const argv = tool({ id: 'a', name: 'commandExecution', input: { command: ['npm', 'test'] } })
    expect(describeTool(argv).target).toBe('npm test')
  })
  it("still prefers the kind's own key over the generic fallback", () => {
    const read = tool({ id: 'a', name: 'Read', input: { file_path: '/x.ts', url: 'http://n' } })
    expect(describeTool(read).target).toBe('/x.ts')
  })
})

describe('visibleEntries', () => {
  it('drops an assistant turn that said nothing, so a run does not break on it', () => {
    const entries = [tool({ id: 'a' }), assistant('   \n '), tool({ id: 'b' })]
    expect(visibleEntries(entries)).toHaveLength(2)
    const blocks = groupEntries(visibleEntries(entries))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind === 'tool-group' && blocks[0].tools).toHaveLength(2)
  })
  it('keeps an assistant turn that said something', () => {
    expect(visibleEntries([assistant('a word')])).toHaveLength(1)
  })
})

describe('safeJson and content', () => {
  it('returns a string rather than throwing on a circular payload', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(typeof safeJson(circular)).toBe('string')
    expect(typeof content(circular)).toBe('string')
  })
  it('does not recurse forever on a payload that points back at itself', () => {
    // content() walks into `content` and into arrays, so it would blow the
    // stack before safeJson's guard was ever reached.
    const selfContent: Record<string, unknown> = {}
    selfContent.content = selfContent
    expect(() => content(selfContent)).not.toThrow()
    const selfArray: unknown[] = []
    selfArray.push(selfArray)
    expect(() => content(selfArray)).not.toThrow()
  })
})

describe('describeToolHead', () => {
  it('gives the summary what it reads and never turns an output into text', () => {
    // A CLOSED run summarises itself on every render of the session. Building
    // the sections there meant a full JSON.stringify of every object-shaped
    // output for a string nobody reads.
    let serialised = 0
    const output = {
      rows: [1, 2, 3],
      get marker() {
        serialised += 1
        return 'seen'
      }
    }
    const t = tool({ id: 'a', name: 'fileChange', input: { file_path: '/x' }, output })
    const head = describeToolHead(t)
    expect(head).toEqual({ kind: 'edit', label: 'Edit', target: '/x' })
    expect(serialised).toBe(0)
    // The full description still carries the output, for an opened item.
    expect(describeTool(t).sections.length).toBeGreaterThan(0)
    expect(serialised).toBeGreaterThan(0)
  })
})

describe('toolPreview', () => {
  it('previews the documented 8 lines and 2000 characters', () => {
    // The README, the commit message and the component all state these figures;
    // asserted literally, because a test written against the constants stays
    // green while they drift away from the prose.
    expect(PREVIEW_LINES).toBe(8)
    expect(PREVIEW_CHARS).toBe(2000)
    expect(toolPreview(Array.from({ length: 12 }, (_, i) => i).join('\n')).text).toBe(
      '0\n1\n2\n3\n4\n5\n6\n7'
    )
  })
  it('never ends on half a character', () => {
    const { text } = toolPreview('x' + '\u{1F600}'.repeat(PREVIEW_CHARS))
    expect(text.length).toBeLessThanOrEqual(PREVIEW_CHARS)
    const last = text.charCodeAt(text.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    expect([...text].every((c) => c === 'x' || c === '\u{1F600}')).toBe(true)
  })
  it('keeps the first lines and reports that there is more', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const preview = toolPreview(text)
    expect(preview.text.split('\n')).toHaveLength(PREVIEW_LINES)
    expect(preview.truncated).toBe(true)
  })
  it('caps on characters as well as lines', () => {
    const preview = toolPreview('x'.repeat(PREVIEW_CHARS + 500))
    expect(preview.text).toHaveLength(PREVIEW_CHARS)
    expect(preview.truncated).toBe(true)
  })
  it('reports nothing truncated when the text already fits', () => {
    expect(toolPreview('short')).toEqual({ text: 'short', truncated: false })
  })
})
