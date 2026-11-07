import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './markdown'

/* The phone parses with the desktop's parser family (remark + GFM), so the
   tree the renderer draws carries what the desktop draws: headings, strong,
   inline code, fences with their language, tables, task lists, links. */

describe('parseMarkdown', () => {
  it('reads headings, emphasis and inline code', () => {
    const tree = parseMarkdown('## Title\n\nA **bold** word and `code`.')
    expect(tree.children.map((n) => n.type)).toEqual(['heading', 'paragraph'])
    const heading = tree.children[0]!
    expect(heading.type === 'heading' && heading.depth).toBe(2)
    const paragraph = tree.children[1]!
    expect(paragraph.type === 'paragraph' && paragraph.children.map((n) => n.type)).toEqual([
      'text',
      'strong',
      'text',
      'inlineCode',
      'text'
    ])
  })

  it('keeps a fence with its language and a GFM table', () => {
    const tree = parseMarkdown(
      '```typescript\nconst ready = true\n```\n\n| File | Status |\n| --- | --- |\n| view.tsx | Ready |'
    )
    const code = tree.children[0]!
    expect(code.type === 'code' && code.lang).toBe('typescript')
    expect(code.type === 'code' && code.value).toBe('const ready = true')
    const table = tree.children[1]!
    expect(table.type).toBe('table')
    expect(table.type === 'table' && table.children.length).toBe(2)
  })

  it('reads GFM task lists, strikethrough and autolinks', () => {
    const tree = parseMarkdown('- [x] done\n- [ ] open\n\n~~gone~~ https://example.com')
    const list = tree.children[0]!
    expect(
      list.type === 'list' && list.children.map((i) => i.type === 'listItem' && i.checked)
    ).toEqual([true, false])
    const paragraph = tree.children[1]!
    expect(paragraph.type === 'paragraph' && paragraph.children.map((n) => n.type)).toEqual([
      'delete',
      'text',
      'link'
    ])
  })

  it('leaves an unfinished fence as code while an answer streams', () => {
    const tree = parseMarkdown('Here:\n\n```bash\nnpm test')
    expect(tree.children.map((n) => n.type)).toEqual(['paragraph', 'code'])
  })
})
