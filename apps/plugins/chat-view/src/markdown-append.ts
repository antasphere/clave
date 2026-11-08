import type { Options } from 'react-markdown'
import type { Nodes, Root } from 'mdast'
import remarkGfm from 'remark-gfm'

type Plugins = NonNullable<Options['remarkPlugins']>
type Attacher = Extract<Plugins[number], (...parameters: never[]) => unknown>
interface Previous {
  source: string
  tree: Root
  start: { line: number; column: number; offset: number }
}

// Only an actual top-level, single-line, plain ASCII paragraph after a blank
// line qualifies. Appending ASCII letters/digits/spaces cannot introduce a
// delimiter, reference, URL, entity, escape, block, line break or indentation.
// Everything else still enters the original full configured parser.
function plainStart(source: string, tree: Root): Previous['start'] | undefined {
  const last = tree.children.at(-1)
  const start = last?.position?.start
  if (
    source.charCodeAt(0) === 0xfeff ||
    last?.type !== 'paragraph' ||
    last.children.length !== 1 ||
    last.children[0].type !== 'text' ||
    start?.column !== 1 ||
    !start.offset ||
    !/(?:\n\n|\r\n\r\n|\r\r)$/.test(source.slice(0, start.offset)) ||
    !/^[A-Za-z0-9][A-Za-z0-9 ]*$/.test(source.slice(start.offset))
  )
    return
  return { line: start.line, column: 1, offset: start.offset }
}

// The cache is private parse data. Downstream remark/rehype transforms receive
// their own tree, so even mutation of a returned tree cannot poison reuse.
// Iterative copying also retains the original deep cases without recursion.
function copyTree(tree: Root): Root {
  const result = {} as Root
  const pending: Array<{ from: object; to: object }> = [{ from: tree, to: result }]
  while (pending.length) {
    const { from, to } = pending.pop()!
    for (const key of Object.keys(from)) {
      const value: unknown = (from as Record<string, unknown>)[key]
      if (value !== null && typeof value === 'object') {
        const child: object = Array.isArray(value)
          ? []
          : Object.create(Object.getPrototypeOf(value))
        Object.defineProperty(to, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true
        })
        pending.push({ from: value, to: child })
      } else
        Object.defineProperty(to, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true
        })
    }
  }
  return result
}

function relocate(tree: Root, start: Previous['start']): void {
  const pending: Nodes[] = [tree]
  while (pending.length) {
    const node = pending.pop()!
    if (node.position)
      for (const point of [node.position.start, node.position.end]) {
        point.line += start.line - 1
        if (point.offset !== undefined) point.offset += start.offset
      }
    if ('children' in node) pending.push(...node.children)
  }
}

/** One factory per mounted EntryRow, memoized only while that assistant entry
 * is unfinished. Finalization/other entry kinds use the original plugin list;
 * unmount drops the closure. No global cache, history, VFile or processor is
 * retained: at most one current source and its private actual parse tree.
 * This list is for the fixed native ReactMarkdown + default GFM pipeline. */
export function createEntryMarkdownPlugins(streaming: boolean): Plugins {
  if (!streaming) return [remarkGfm]
  let previous: Previous | undefined
  const append: Attacher = function () {
    const parser = this.parser!
    this.parser = (source, file) => {
      const before = previous
      previous = undefined
      let tree: Root
      if (
        before &&
        source.startsWith(before.source) &&
        /^[A-Za-z0-9 ]+$/.test(source.slice(before.source.length))
      ) {
        // The tail still goes through the actual configured remark parser.
        // VFile remains the full canonical input for the public pipeline.
        const tail = parser(source.slice(before.start.offset), file) as Root
        relocate(tail, before.start)
        tree = {
          ...before.tree,
          children: [...before.tree.children.slice(0, -1), ...tail.children],
          position: { start: before.tree.position!.start, end: tail.position!.end }
        }
      } else tree = parser(source, file) as Root
      const start = plainStart(source, tree)
      if (!start) return tree
      previous = { source, tree, start }
      return copyTree(tree)
    }
  }
  return [remarkGfm, append]
}
