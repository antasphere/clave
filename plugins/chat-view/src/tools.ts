import type { Entry } from './reducer'

/* What a run of tool calls says between two messages, decided without a DOM so
   both views of this plugin read it the same way and a test can pin it.
   Ported from the behaviour of pull request #58, not from its code: that branch
   reduced a provider transcript whose tools already carried a status and whose
   input and output were strings, while this plugin reduces the public event
   transport, where both are `unknown` and the failure is the adapter's own flag. */

export type ToolEntry = Extract<Entry, { kind: 'tool' }>
export interface ToolGroup {
  kind: 'tool-group'
  /** The first tool's id: stable as the run grows, which is what lets the
   *  reader's expansion survive a result arriving. */
  id: string
  tools: ToolEntry[]
}
export type Block = Exclude<Entry, { kind: 'tool' }> | ToolGroup

/** A MESSAGE ends a run of tools; a permission card does not. The reader asked
 *  a question, the agent worked, the agent answered: the work between those two
 *  turns is one step, and the approval the agent needed mid-run is part of it
 *  rather than a border. (The view before this one broke the run on any
 *  non-tool entry, so one permission split a single step into two rows.) */
/** An assistant turn that opened and said nothing renders nowhere, so it may
 *  not end a run either — otherwise the run breaks in a place the reader cannot
 *  see. Both views filter through THIS, so both break a run in the same place;
 *  the conversation view used to filter before grouping and the compact view
 *  not at all, which split a run in one view and not the other. */
export function visibleEntries(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.kind !== 'assistant' || e.text.trim() !== '')
}

export function groupEntries(entries: Entry[]): Block[] {
  const blocks: Block[] = []
  let open: ToolGroup | undefined
  for (const entry of entries) {
    if (entry.kind === 'tool') {
      if (!open) {
        open = { kind: 'tool-group', id: entry.id, tools: [] }
        blocks.push(open)
      }
      open.tools.push(entry)
      continue
    }
    blocks.push(entry)
    if (entry.kind === 'user' || entry.kind === 'assistant') open = undefined
  }
  return blocks
}

export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'other'
export interface Section {
  label: string
  text: string
}
export interface ToolDescription {
  kind: ToolKind
  label: string
  target: string
  detail?: string
  sections: Section[]
}

const READ = ['read', 'readfile']
const SEARCH = ['grep', 'glob', 'search', 'searchfiles', 'find', 'websearch', 'ripgrep']
const EDIT = ['edit', 'write', 'writefile', 'applypatch', 'filechange', 'multiedit']
const COMMAND = ['bash', 'shell', 'commandexecution', 'execcommand', 'runcommand']

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function field(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value) return value
    // argv rather than a command line: Codex sends `command` as an array.
    if (Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length)
      return value.join(' ')
  }
  return ''
}
/* The argument a human recognises a call by, when the kind's own keys found
   nothing. The port from #58 read only path / pattern / command keys, which
   left every WebFetch, Task, TodoWrite and MCP call reading as a bare name —
   the helper this replaced looked wider than that, and so does this. */
const GENERIC_KEYS = ['url', 'description', 'prompt', 'title', 'name', 'id']
function anyTarget(data: Record<string, unknown>): string {
  const known = field(data, ...GENERIC_KEYS)
  if (known) return known
  for (const key of Object.keys(data)) {
    const value = data[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}
function numberField(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}
/** Plain text blocks are common to several tools; anything else stays readable
 *  JSON rather than `[object Object]`. */
export function content(value: unknown, seen: Set<object> = new Set()): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return String(value)
  // The recursion below walks into arrays and into `content`, so a payload that
  // points back at itself would blow the stack before safeJson's guard is ever
  // reached. Adapter payloads are JSON.parse output and acyclic; a render is
  // still not a place to find out otherwise.
  if (seen.has(value)) return ''
  seen.add(value)
  if (Array.isArray(value))
    return value
      .map((v) => content(v, seen))
      .filter(Boolean)
      .join('\n')
  const data = record(value)
  if (typeof data.text === 'string') return data.text
  if (data.content !== undefined) return content(data.content, seen)
  if (typeof data.stdout === 'string' || typeof data.stderr === 'string')
    return [data.stdout, data.stderr].filter((v) => typeof v === 'string' && v).join('\n')
  return safeJson(value)
}
/** A render may not throw. `JSON.stringify` does, on a circular payload. */
export function safeJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent) ?? ''
  } catch {
    return String(value)
  }
}

/* What the summary line needs, and nothing more. Kept apart from describeTool
   because a CLOSED run still summarises itself on every render of the session,
   and describeTool's last act is to turn every output into text — a full
   JSON.stringify for the object-shaped outputs Codex sends for a file change
   and Claude sends as content blocks. Measured at about 25 ms per render per
   run on ten tools with large object outputs, for a string nobody reads. */
export function describeToolHead(
  tool: ToolEntry
): Pick<ToolDescription, 'kind' | 'label' | 'target'> {
  const { kind, label, target } = describeTool(tool, false)
  return { kind, label, target }
}

export function describeTool(tool: ToolEntry, withSections = true): ToolDescription {
  const name = (tool.name ?? '').toLowerCase().replace(/[\s_-]/g, '')
  const kind: ToolKind = READ.includes(name)
    ? 'read'
    : SEARCH.includes(name)
      ? 'search'
      : EDIT.includes(name)
        ? 'edit'
        : COMMAND.includes(name)
          ? 'command'
          : 'other'
  const labels: Record<ToolKind, string> = {
    read: 'Read',
    search: 'Search',
    edit: 'Edit',
    command: 'Shell',
    other: tool.name ?? 'Tool'
  }
  const input = tool.input
  const data = record(input)
  const path = field(data, 'file_path', 'filePath', 'path', 'filename')
  const query = field(data, 'pattern', 'query', 'glob')
  const command = field(data, 'command', 'cmd')
  const literal = typeof input === 'string' ? input : ''
  const byKind =
    kind === 'search'
      ? query || literal || path
      : kind === 'command'
        ? command || literal
        : path || literal
  const target = byKind || anyTarget(data)
  const sections: Section[] = []
  if (withSections && (target.includes('\n') || target.length > 200))
    sections.push({ label: kind === 'command' ? 'Command' : 'Target', text: target })
  let detail: string | undefined
  if (kind === 'read') {
    const start = numberField(data, 'offset', 'start_line', 'startLine')
    const limit = numberField(data, 'limit')
    const end =
      numberField(data, 'end_line', 'endLine') ??
      (start !== undefined && limit !== undefined ? start + limit - 1 : undefined)
    if (start !== undefined)
      detail = end !== undefined ? `Lines ${start}–${end}` : `From line ${start}`
    else if (limit !== undefined) detail = `Up to ${limit} lines`
  } else if (kind === 'search') {
    if (path && path !== target) detail = `In ${path}`
  } else if (kind === 'edit' && withSections) {
    const changes = Array.isArray(input) ? input.map(record) : [data]
    for (const change of changes) {
      const diff = field(change, 'diff', 'patch')
      const before = field(change, 'old_string', 'oldText', 'old_text')
      const after = field(change, 'new_string', 'newText', 'new_text')
      const text =
        diff ||
        (before || after
          ? [
              ...(before ? before.split('\n').map((line) => `- ${line}`) : []),
              ...(after ? after.split('\n').map((line) => `+ ${line}`) : [])
            ].join('\n')
          : field(change, 'content'))
      if (text) sections.push({ label: field(change, 'path', 'file_path') || 'Changes', text })
    }
  }
  const exit = numberField(record(tool.output), 'exit_code', 'exitCode')
  if (kind === 'command' && exit !== undefined) detail = `Exit ${exit}`
  const outputText = withSections && tool.complete ? content(tool.output) : ''
  if (outputText)
    sections.push({
      label: kind === 'read' ? 'Content' : kind === 'search' ? 'Matches' : 'Output',
      text: outputText
    })
  if (withSections && !sections.length && !target && tool.input !== undefined) {
    const inputText = content(input)
    if (inputText) sections.push({ label: 'Input', text: inputText })
  }
  return { kind, label: labels[kind], target, detail, sections }
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** The one line a closed group shows: what the agent did, counted by kind.
 *  A lone tool names itself instead, because "Read 1 file" tells a reader less
 *  than the path does. */
export function toolGroupSummary(tools: ToolEntry[]): string {
  if (tools.length === 0) return ''
  if (tools.length === 1) {
    const { label, target } = describeToolHead(tools[0])
    return target ? `${label} · ${target}` : label
  }
  const counts = new Map<
    string,
    { kind: ToolKind; label: string; count: number; targets: Set<string>; named: number }
  >()
  for (const tool of tools) {
    const { kind, label, target } = describeToolHead(tool)
    const key = kind === 'other' ? `other:${label}` : kind
    const previous = counts.get(key)
    const targets = previous?.targets ?? new Set<string>()
    if (target) targets.add(target)
    counts.set(key, {
      kind,
      label,
      count: (previous?.count ?? 0) + 1,
      targets,
      // "Read 2 files" may only be said when every read named a file. One
      // unreadable call among five made the row claim a single file.
      named: (previous?.named ?? 0) + (target ? 1 : 0)
    })
  }
  return [...counts.values()]
    .map(({ kind, label, count, targets, named }) => {
      const files = (verb: string): string =>
        targets.size && named === count
          ? `${verb} ${targets.size} ${targets.size === 1 ? 'file' : 'files'}`
          : `${verb} ${times(count)}`
      if (kind === 'read') return files('Read')
      if (kind === 'edit') return files('Edited')
      if (kind === 'command') return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`
      if (kind === 'search') return `Searched ${times(count)}`
      return `${label} × ${count}`
    })
    .join(' · ')
}

export type GroupStatus = 'running' | 'failed' | 'complete'
/** Running wins over failed: something is still in flight and the row must say
 *  so, with the failure count carried beside it rather than instead of it. */
export function groupStatus(tools: ToolEntry[]): GroupStatus {
  if (tools.some((tool) => !tool.complete)) return 'running'
  return tools.some((tool) => tool.failed === true) ? 'failed' : 'complete'
}
export function failureCount(tools: ToolEntry[]): number {
  return tools.filter((tool) => tool.failed === true).length
}

export const PREVIEW_LINES = 8
export const PREVIEW_CHARS = 2000
/** What an opened tool shows before the reader asks for the rest. */
export function toolPreview(text: string): { text: string; truncated: boolean } {
  let preview = text.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)
  // A slice at PREVIEW_CHARS can land between the two halves of an astral
  // character; the lone surrogate left behind renders as U+FFFD.
  const last = preview.charCodeAt(preview.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) preview = preview.slice(0, -1)
  return { text: preview, truncated: preview.length < text.length }
}
