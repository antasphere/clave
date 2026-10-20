import { createElement, Fragment, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { demand, literal } from '../../../../tests/e2e/markdown-deep-contract.mjs'
import { project } from './markdown-data-projection'

type RemarkAttacher = Extract<
  NonNullable<Options['remarkPlugins']>[number],
  (...parameters: never[]) => unknown
>
type MarkdownProcessor = ThisParameterType<RemarkAttacher>
type MarkdownParser = NonNullable<MarkdownProcessor['parser']>
type MarkdownTree = ReturnType<MarkdownParser>
type MarkdownFile = Parameters<MarkdownParser>[1]

interface Entry {
  length: number
  fullLength: number
  sameFile: boolean
}
export interface Stages {
  mdast: MarkdownTree
  hast: unknown
  jsx: unknown
  urls: string[]
  entries: Entry[]
}

// A lossless ordered data projection. React owner/debug bookkeeping is omitted
// only at the element boundary. Every key and prop (including children) remains.
// Unknown component types, callable/symbol props and exotic objects fail closed.
export { project }

export function sameData(left: unknown, right: unknown, message: string): void {
  demand(JSON.stringify(project(left)) === JSON.stringify(project(right)), message)
}

export function publicStages(input: string): Stages {
  const entries: Entry[] = [],
    files: MarkdownFile[] = [],
    urls: string[] = []
  let mdast: MarkdownTree | undefined, hast: unknown, downstream: MarkdownFile | undefined
  function instrument(this: MarkdownProcessor): void {
    const original = this.parser
    demand(original, 'configured public parser missing')
    this.parser = (document, file) => {
      entries.push({
        length: document.length,
        fullLength: String(file.value).length,
        sameFile: false
      })
      files.push(file)
      return original!(document, file)
    }
  }
  function collectMdast(): (tree: MarkdownTree, file: MarkdownFile) => void {
    return (tree, file) => {
      mdast = tree
      downstream = file
    }
  }
  function collectHast(): (tree: unknown) => void {
    return (tree) => {
      hast = tree
    }
  }
  const plugins: NonNullable<Options['remarkPlugins']> = [
    [remarkGfm, { singleTilde: true }],
    instrument,
    collectMdast
  ]
  // The actual pinned hook-free public synchronous entry, never a reconstructed
  // unified pipeline or a hook-using MarkdownMessage called outside React.
  const jsx = ReactMarkdown({
    children: input,
    remarkPlugins: plugins,
    rehypePlugins: [collectHast],
    urlTransform(url) {
      const safe = defaultUrlTransform(url)
      urls.push(url + ' => ' + safe)
      return safe
    }
  })
  demand(mdast && hast && entries.length > 0, 'complete public pipeline entered')
  entries.forEach((entry, i) => {
    entry.sameFile = files[i] === downstream
    demand(entry.sameFile && entry.fullLength === input.length, 'exact complete VFile identity')
  })
  demand(
    entries.length === 1 && entries[0].length === input.length,
    'complete original parser input'
  )
  return { mdast: mdast!, hast, jsx, urls, entries }
}

// Expected positional MDAST is generated from the literal grammar's delimiters,
// independently of either parser arm. Positions include every text descendant.
function expectedMdast(depth: number, stage: 'initial' | 'append'): unknown {
  const expected = literal(depth, stage),
    firstEnd = 14 * depth + 6
  const point = (offset: number): { line: number; column: number; offset: number } =>
    offset <= firstEnd
      ? { line: 1, column: offset + 1, offset }
      : { line: 3, column: offset - firstEnd - 1, offset }
  const node = (type: string, start: number, end: number, extra: object): object => ({
    type,
    ...extra,
    position: { start: point(start), end: point(end) }
  })
  const text = (start: number, end: number): object =>
    node('text', start, end, { value: expected.input.slice(start, end) })
  let nested: object | undefined
  for (let n = depth - 1; n >= 0; n--) {
    const start = 7 * n,
      end = firstEnd - 7 * n
    const strong = node('strong', start + 3, end - 3, {
      children: nested
        ? [text(start + 5, start + 7), nested, text(end - 7, end - 5)]
        : [text(start + 5, end - 5)]
    })
    nested = node('emphasis', start, end, {
      children: [text(start + 1, start + 3), strong, text(end - 3, end - 1)]
    })
  }
  return node('root', 0, expected.input.length, {
    children: [
      node('paragraph', 0, firstEnd, { children: [nested] }),
      node('paragraph', firstEnd + 2, expected.input.length, {
        children: [text(firstEnd + 2, expected.input.length)]
      })
    ]
  })
}

// Serialize only this fixed literal grammar, with no normalization. This does
// not call SSR. Other host elements/attributes fail instead of being dropped.
export function literalJsx(value: unknown): string {
  const tokens: string[] = []
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') {
      tokens.push(item)
      continue
    }
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) pending.push(item[i])
      continue
    }
    demand(isValidElement<Record<string, unknown>>(item), 'literal JSX must be complete')
    if (!isValidElement<Record<string, unknown>>(item)) throw new Error('Invalid JSX')
    demand(
      Object.keys(item.props).every((key) => key === 'children'),
      'unexpected literal JSX prop'
    )
    if (item.type === Fragment) {
      pending.push(item.props.children)
      continue
    }
    demand(['p', 'em', 'strong'].includes(String(item.type)), 'unexpected literal JSX host')
    tokens.push('<' + item.type + '>')
    pending.push('</' + item.type + '>', item.props.children)
  }
  return tokens.join('')
}

export function checkDeepStages(result: Stages, depth: number, stage: 'initial' | 'append'): void {
  const expected = expectedMdast(depth, stage)
  sameData(result.mdast, expected, 'independent complete positional MDAST')
  demand(
    literalJsx(result.jsx) === literal(depth, stage).html,
    'independent complete ordered JSX literal'
  )
  // The expected delimiter grammar supplies positions independently. Map only
  // its declared literal tags, including the generated inter-block newline.
  type Grammar = { type: string; value?: string; position?: unknown; children?: Grammar[] }
  type Html = {
    type: string
    tagName?: string
    value?: string
    position?: unknown
    properties?: object
    children?: Html[]
  }
  const toHtml = (node: Grammar): Html => {
    if (node.type === 'text') return { type: 'text', value: node.value, position: node.position }
    const children = node.children!.map(toHtml)
    if (node.type === 'root')
      return {
        type: 'root',
        children: [children[0], { type: 'text', value: '\n' }, children[1]],
        position: node.position
      }
    const tagName = { paragraph: 'p', emphasis: 'em', strong: 'strong' }[node.type]!
    return { type: 'element', tagName, properties: {}, children, position: node.position }
  }
  const expectedHtml = toHtml(expected as Grammar)
  sameData(result.hast, expectedHtml, 'independent complete positioned HAST')
  const toJsx = (node: Html, key: string | null): ReactNode => {
    if (node.type === 'text') return node.value
    const counts = new Map<string, number>()
    const children = node.children!.map((child) => {
      if (child.type === 'text') return child.value
      const n = counts.get(child.tagName!) ?? 0
      counts.set(child.tagName!, n + 1)
      return toJsx(child, child.tagName + '-' + n)
    })
    return createElement(
      node.type === 'root' ? Fragment : node.tagName!,
      key === null ? {} : { key },
      children.length === 1 ? children[0] : children
    )
  }
  sameData(result.jsx, toJsx(expectedHtml, null), 'independent complete JSX keys/props/order')
  const pending = [result.hast],
    tokens: string[] = []
  while (pending.length) {
    const n = pending.pop() as
      | {
          type: string
          tagName?: string
          value?: string
          children?: unknown[]
          properties?: object
        }
      | string
    if (typeof n === 'string') {
      tokens.push(n)
      continue
    }
    if (n.type === 'text') {
      tokens.push(n.value!)
      continue
    }
    demand(
      n.type === 'root' || (n.type === 'element' && ['p', 'em', 'strong'].includes(n.tagName!)),
      'complete HAST grammar'
    )
    if (n.type === 'element') {
      demand(Object.keys(n.properties ?? {}).length === 0, 'literal HAST props')
      tokens.push('<' + n.tagName + '>')
      pending.push('</' + n.tagName + '>')
    }
    demand(Array.isArray(n.children), 'HAST children present')
    for (let i = n.children!.length - 1; i >= 0; i--) pending.push(n.children![i])
  }
  demand(
    tokens.join('') === literal(depth, stage).html,
    'independent complete ordered HAST literal'
  )
  sameData(result.urls, [], 'deep literal has no URLs')
}
