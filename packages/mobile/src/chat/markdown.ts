/**
 * The assistant's Markdown, parsed the way the desktop's chat view parses
 * it: remark with GitHub flavoured Markdown (`react-markdown`'s own pipeline,
 * `plugins/chat-view/src/markdown-append.ts`), to the same syntax tree
 * (mdast), which `screens/chat/Markdown.tsx` draws with the phone's text.
 * The desktop's streaming shortcut (re-parsing only the tail of a growing
 * paragraph) is not ported: an answer is re-parsed whole on each delta,
 * memoised per entry.
 */
import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const processor = unified().use(remarkParse).use(remarkGfm)

export function parseMarkdown(text: string): Root {
  return processor.parse(text) as Root
}
