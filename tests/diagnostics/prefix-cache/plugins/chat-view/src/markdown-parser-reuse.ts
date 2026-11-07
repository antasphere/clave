import type { Options } from 'react-markdown'

// All parser types come from the public renderer API.
type RemarkAttacher = Extract<
  NonNullable<Options['remarkPlugins']>[number],
  (...parameters: never[]) => unknown
>
export type MarkdownProcessor = ThisParameterType<RemarkAttacher>
export type MarkdownParser = NonNullable<MarkdownProcessor['parser']>
export type MarkdownTree = ReturnType<MarkdownParser>
export type MarkdownFile = Parameters<MarkdownParser>[1]

export function markdownParserBoundary(
  parsed: (document: string, file: MarkdownFile, tree: MarkdownTree) => void
): RemarkAttacher {
  return function (this: MarkdownProcessor): void {
    const original = this.parser
    if (!original) throw new Error('Configured Markdown parser is missing')
    this.parser = (document, file) => {
      const tree = original(document, file)
      parsed(document, file, tree)
      return tree
    }
  }
}

export const PREFIX_LIMITS = { blocks: 64, sourceBytes: 128 * 1024, nodes: 4096 } as const

type Point = { line: number; column: number; offset: number }
type Position = { start: Point; end: Point }
type PrefixNode = {
  type: string
  position?: Position
  children?: PrefixNode[]
  value?: string
  url?: string
  title?: string | null
  alt?: string | null
  depth?: number
}
export interface PrefixAccounting {
  blocks: number
  nodes: number
  sourceSpanCodeUnits: number
  astStringCodeUnits: number
  sourceBytes: number
}
export interface PrefixSnapshot {
  // A reference to the current supplied input, never a copied old input/tail.
  input: string
  cut: number
  line: number
  blocks: PrefixNode[]
  rootStart: Point
  accounting: PrefixAccounting
}
export type PrefixInspection =
  | { kind: 'candidate'; snapshot: PrefixSnapshot; accounting: PrefixAccounting }
  | {
      kind: 'full'
      reason:
        | 'final'
        | 'unsupported'
        | 'no-prefix'
        | 'position'
        | 'block-cap'
        | 'source-cap'
        | 'node-cap'
      accounting?: PrefixAccounting
    }

const inline = new Set([
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'break',
  'link',
  'image'
])
const fields = new Set(['type', 'position', 'children', 'value', 'url', 'title', 'alt', 'depth'])
const strings = ['value', 'url', 'title', 'alt'] as const
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function point(value: unknown, length: number): value is Point {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['line', 'column', 'offset'].includes(key)) &&
    Number.isInteger(value.line) &&
    Number(value.line) >= 1 &&
    Number.isInteger(value.column) &&
    Number(value.column) >= 1 &&
    Number.isInteger(value.offset) &&
    Number(value.offset) >= 0 &&
    Number(value.offset) <= length
  )
}
function position(value: unknown, length: number): value is Position {
  return (
    record(value) &&
    Object.keys(value).every((key) => ['start', 'end'].includes(key)) &&
    point(value.start, length) &&
    point(value.end, length) &&
    value.start.offset <= value.end.offset
  )
}
function node(value: unknown, length: number, top: boolean): value is PrefixNode {
  const pending: Array<{ value: unknown; top: boolean }> = [{ value, top }]
  while (pending.length) {
    const current = pending.pop()!
    const n = current.value
    if (
      !record(n) ||
      typeof n.type !== 'string' ||
      !(current.top ? ['paragraph', 'heading'].includes(n.type) : inline.has(n.type)) ||
      !Object.keys(n).every((key) => fields.has(key))
    )
      return false
    if (n.position !== undefined && !position(n.position, length)) return false
    if (
      strings.some((key) => n[key] !== undefined && n[key] !== null && typeof n[key] !== 'string')
    )
      return false
    if (
      n.depth !== undefined &&
      (!Number.isInteger(n.depth) || Number(n.depth) < 1 || Number(n.depth) > 6)
    )
      return false
    if (n.children !== undefined) {
      if (!Array.isArray(n.children)) return false
      for (const child of n.children) pending.push({ value: child, top: false })
    }
  }
  return true
}

// Iterative copying avoids adding a structuredClone/recursive-walk depth limit
// for phrasing the original parser and renderer can accept.
function clonePrefixNodes(nodes: ReadonlyArray<PrefixNode>): PrefixNode[] {
  const copies: PrefixNode[] = []
  const pending = nodes.map((source) => ({ source, target: copies }))
  for (let i = 0; i < pending.length; i++) {
    const { source, target } = pending[i]
    const copy = { ...source }
    if (source.position)
      copy.position = {
        start: { ...source.position.start },
        end: { ...source.position.end }
      }
    if (source.children) {
      copy.children = []
      for (const child of source.children) pending.push({ source: child, target: copy.children })
    }
    target.push(copy)
  }
  return copies
}

// Charge every source-derived string occurrence, even equal/shared values. The
// retained source span is charged separately, including whitespace/separators.
export function accountPrefix(blocks: ReadonlyArray<PrefixNode>, cut: number): PrefixAccounting {
  let nodes = 0,
    astStringCodeUnits = 0
  const pending = [...blocks]
  while (pending.length) {
    const n = pending.pop()!
    nodes++
    for (const field of strings) astStringCodeUnits += n[field]?.length ?? 0
    if (n.children) for (const child of n.children) pending.push(child)
  }
  return {
    blocks: blocks.length,
    nodes,
    sourceSpanCodeUnits: cut,
    astStringCodeUnits,
    sourceBytes: 2 * (cut + astStringCodeUnits)
  }
}

function lineStart(input: string, offset: number): { offset: number; line: number } | undefined {
  let start = 0,
    line = 1
  for (let i = 0; i < offset; i++) {
    if (input[i] === '\r' || input[i] === '\n') {
      if (input[i] === '\r' && input[i + 1] === '\n') i++
      if (i >= offset) return undefined
      start = i + 1
      line++
    }
  }
  return { offset: start, line }
}

/** Inspect the full parser's actual candidate, without truncating to fit caps.
 * An accepted snapshot owns only cloned prefix nodes plus one current input
 * reference. Rejected/final results retain no nodes, input, tail or parser.
 * This source/node accounting is not a retained-heap measurement. */
export function inspectParserPrefix(
  input: string,
  tree: MarkdownTree,
  final = false
): PrefixInspection {
  if (final) return { kind: 'full', reason: 'final' }
  if (
    !record(tree) ||
    tree.type !== 'root' ||
    !Object.keys(tree).every((key) => ['type', 'children', 'position'].includes(key)) ||
    !Array.isArray(tree.children) ||
    !tree.children.every((child) => node(child, input.length, true)) ||
    input.includes('\uFEFF')
  )
    return { kind: 'full', reason: 'unsupported' }
  if (tree.children.length < 2) return { kind: 'full', reason: 'no-prefix' }
  const children = tree.children
  const last = children[children.length - 1]
  if (!last.position || !position(tree.position, input.length))
    return { kind: 'full', reason: 'position' }
  const cut = lineStart(input, last.position.start.offset)
  if (
    !cut ||
    cut.line !== last.position.start.line ||
    cut.offset === 0 ||
    children.slice(0, -1).some((child) => !child.position || child.position.end.offset > cut.offset)
  )
    return { kind: 'full', reason: 'position' }
  const blocks = children.slice(0, -1)
  const accounting = accountPrefix(blocks, cut.offset)
  if (accounting.blocks > PREFIX_LIMITS.blocks)
    return { kind: 'full', reason: 'block-cap', accounting }
  if (accounting.sourceBytes > PREFIX_LIMITS.sourceBytes)
    return { kind: 'full', reason: 'source-cap', accounting }
  if (accounting.nodes > PREFIX_LIMITS.nodes)
    return { kind: 'full', reason: 'node-cap', accounting }
  return {
    kind: 'candidate',
    accounting,
    snapshot: {
      input,
      cut: cut.offset,
      line: cut.line,
      blocks: clonePrefixNodes(blocks),
      rootStart: { ...tree.position.start },
      accounting
    }
  }
}

export type CommittedMarkdown =
  | { kind: 'prefix'; signature: string; snapshot: PrefixSnapshot }
  | { kind: 'full'; signature: string; input: string; blocked: boolean }
export interface MarkdownStore {
  getSnapshot(): CommittedMarkdown | undefined
  subscribe(listener: () => void): () => void
  publish(next: CommittedMarkdown | undefined): void
  clear(): void
}

// Compare the complete bounded metadata, not just text. This remains correct
// if React retries the parser subtree despite its advisory memoization.
export function sameCommittedMarkdown(
  left: CommittedMarkdown | undefined,
  right: CommittedMarkdown | undefined
): boolean {
  if (left === right) return true
  if (!left || !right || left.kind !== right.kind || left.signature !== right.signature)
    return false
  if (left.kind === 'full' && right.kind === 'full')
    return left.input === right.input && left.blocked === right.blocked
  if (left.kind !== 'prefix' || right.kind !== 'prefix') return false
  const a = left.snapshot,
    b = right.snapshot
  if (
    a.input !== b.input ||
    a.cut !== b.cut ||
    a.line !== b.line ||
    !samePoint(a.rootStart, b.rootStart) ||
    Object.keys(a.accounting).some(
      (key) =>
        a.accounting[key as keyof PrefixAccounting] !== b.accounting[key as keyof PrefixAccounting]
    )
  )
    return false
  const pending = [{ a: a.blocks, b: b.blocks }]
  while (pending.length) {
    const pair = pending.pop()!
    if (pair.a.length !== pair.b.length) return false
    for (let i = 0; i < pair.a.length; i++) {
      const x = pair.a[i],
        y = pair.b[i]
      if (
        x.type !== y.type ||
        x.depth !== y.depth ||
        strings.some((key) => x[key] !== y[key]) ||
        Boolean(x.position) !== Boolean(y.position) ||
        Boolean(x.children) !== Boolean(y.children)
      )
        return false
      if (
        x.position &&
        y.position &&
        (!samePoint(x.position.start, y.position.start) ||
          !samePoint(x.position.end, y.position.end))
      )
        return false
      if (x.children && y.children) pending.push({ a: x.children, b: y.children })
    }
  }
  return true
}
function samePoint(a: Point, b: Point): boolean {
  return a.line === b.line && a.column === b.column && a.offset === b.offset
}
function freezeCommitted(next: CommittedMarkdown | undefined): void {
  const pending: unknown[] = [next]
  while (pending.length) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) continue
    for (const child of Object.values(value)) pending.push(child)
    Object.freeze(value)
  }
}

/** One store per mounted row. React reads its cached immutable snapshot through
 * useSyncExternalStore. It contains no parser, processor or snapshot history. */
export function createMarkdownStore(): MarkdownStore {
  let snapshot: CommittedMarkdown | undefined
  const listeners = new Set<() => void>()
  function publish(next: CommittedMarkdown | undefined): void {
    if (sameCommittedMarkdown(snapshot, next)) return
    freezeCommitted(next)
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish,
    clear: () => publish(undefined)
  }
}
export interface MarkdownAttempt {
  plugin: RemarkAttacher
  ready(): boolean
  candidate(): CommittedMarkdown | undefined
  release(): void
}

function inputOf(state: CommittedMarkdown): string {
  return state.kind === 'prefix' ? state.snapshot.input : state.input
}
function eligibleRoot(
  tree: MarkdownTree,
  length: number
): tree is MarkdownTree & {
  children: PrefixNode[]
  position: Position
} {
  return (
    record(tree) &&
    tree.type === 'root' &&
    Object.keys(tree).every((key) => ['type', 'children', 'position'].includes(key)) &&
    Array.isArray(tree.children) &&
    tree.children.every((child) => node(child, length, true)) &&
    position(tree.position, length)
  )
}
function rebase(nodes: ReadonlyArray<PrefixNode>, offset: number, lines: number): void {
  const pending = [...nodes]
  while (pending.length) {
    const n = pending.pop()!
    if (n.position) {
      n.position.start.offset += offset
      n.position.end.offset += offset
      n.position.start.line += lines
      n.position.end.line += lines
    }
    if (n.children) for (const child of n.children) pending.push(child)
  }
}

/** A render-local, releasable advisory base. The nested parser fills readiness;
 * only its successfully committed renderer may publish the candidate. */
export function createMarkdownAttempt(
  committed: CommittedMarkdown | undefined,
  input: string,
  final: boolean,
  signature: string
): MarkdownAttempt {
  let base = committed
  let next: CommittedMarkdown | undefined
  let complete = false
  function release(): void {
    base = undefined
  }
  function plugin(this: MarkdownProcessor): void {
    const original = this.parser
    if (!original) throw new Error('Configured Markdown parser is missing')
    this.parser = (document, file) => {
      complete = false
      next = undefined
      if (document !== input || file.value !== input)
        throw new Error('Markdown attempt input mismatch')
      const append = !final && base?.signature === signature && document.startsWith(inputOf(base))
      const blocked = append && base?.kind === 'full' && base.blocked
      let tree: MarkdownTree
      let reused = false
      if (append && base?.kind === 'prefix' && !document.includes('\uFEFF')) {
        const prefix = base.snapshot
        const tail = original(document.slice(prefix.cut), file)
        if (eligibleRoot(tail, document.length - prefix.cut) && tail.children.length > 0) {
          reused = true
          rebase(tail.children, prefix.cut, prefix.line - 1)
          const merged = {
            ...tail,
            children: [...clonePrefixNodes(prefix.blocks), ...tail.children],
            position: {
              start: { ...prefix.rootStart },
              end: {
                ...tail.position.end,
                offset: tail.position.end.offset + prefix.cut,
                line: tail.position.end.line + prefix.line - 1
              }
            }
          }
          tree = merged
        } else {
          tree = original(document, file)
        }
      } else {
        tree = original(document, file)
      }
      if (!final) {
        const inspection = blocked ? undefined : inspectParserPrefix(document, tree)
        if (inspection?.kind === 'candidate')
          next = { kind: 'prefix', signature, snapshot: inspection.snapshot }
        else {
          if (reused) tree = original(document, file)
          next = {
            kind: 'full',
            signature,
            input: document,
            blocked: blocked || inspection?.reason !== 'no-prefix'
          }
        }
      }
      complete = true
      return tree
    }
  }
  return { plugin, ready: () => complete, candidate: () => next, release }
}
