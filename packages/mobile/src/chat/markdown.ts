/**
 * The assistant's Markdown, parsed the way the desktop's chat view parses
 * it: remark with GitHub flavoured Markdown (`react-markdown`'s own pipeline,
 * `plugins/chat-view/src/markdown-append.ts`), to the same syntax tree
 * (mdast), which `screens/chat/Markdown.tsx` draws with the phone's text.
 * The desktop's streaming shortcut (re-parsing only the tail of a growing
 * paragraph) is not ported: an answer is re-parsed whole on each delta,
 * memoised per entry.
 */
import type { Definition, Image, ImageReference, Link, LinkReference, Root } from 'mdast'
import type { Node, Parent } from 'unist'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const processor = unified().use(remarkParse).use(remarkGfm)

export function parseMarkdown(text: string): Root {
  const tree = processor.parse(text) as Root
  const definitions = new Map<string, Definition>()
  const visit = (node: Node, fn: (parent: Parent, index: number, child: Node) => void): void => {
    if (!('children' in node)) return
    const parent = node as Parent
    parent.children.forEach((child, index) => {
      fn(parent, index, child)
      visit(parent.children[index]!, fn)
    })
  }
  visit(tree, (_parent, _index, node) => {
    if (node.type !== 'definition') return
    const definition = node as Definition
    const key = definition.identifier.toUpperCase()
    if (!definitions.has(key)) definitions.set(key, definition)
  })
  visit(tree, (parent, index, node) => {
    if (node.type !== 'linkReference' && node.type !== 'imageReference') return
    const reference = node as LinkReference | ImageReference
    const definition = definitions.get(reference.identifier.toUpperCase())
    if (!definition) return
    const common = { url: definition.url, title: definition.title, position: reference.position }
    const resolved: Link | Image =
      reference.type === 'linkReference'
        ? { type: 'link', children: reference.children, ...common }
        : { type: 'image', alt: reference.alt, ...common }
    parent.children[index] = resolved
  })
  return tree
}
