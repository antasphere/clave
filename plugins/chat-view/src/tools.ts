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
export function content(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.map(content).filter(Boolean).join('\n')
  const data = record(value)
  if (typeof data.text === 'string') return data.text
  if (data.content !== undefined) return content(data.content)
  if (typeof data.stdout === 'string' || typeof data.stderr === 'string')
    return [data.stdout, data.stderr].filter((v) => typeof v === 'string' && v).join('\n')
  return JSON.stringify(value, null, 2) ?? ''
}

export function describeTool(tool: ToolEntry): ToolDescription {
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
  const target =
    kind === 'search'
      ? query || literal || path
      : kind === 'command'
        ? command || literal
        : path || literal
  const sections: Section[] = []
  if (target.includes('\n') || target.length > 200)
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
  } else if (kind === 'edit') {
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
  const outputText = tool.complete ? content(tool.output) : ''
  if (outputText)
    sections.push({
      label: kind === 'read' ? 'Content' : kind === 'search' ? 'Matches' : 'Output',
      text: outputText
    })
  if (!sections.length && !target && tool.input !== undefined) {
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
    const { label, target } = describeTool(tools[0])
    return target ? `${label} · ${target}` : label
  }
  const counts = new Map<
    string,
    { kind: ToolKind; label: string; count: number; targets: Set<string> }
  >()
  for (const tool of tools) {
    const { kind, label, target } = describeTool(tool)
    const key = kind === 'other' ? `other:${label}` : kind
    const previous = counts.get(key)
    const targets = previous?.targets ?? new Set<string>()
    if (target) targets.add(target)
    counts.set(key, { kind, label, count: (previous?.count ?? 0) + 1, targets })
  }
  return [...counts.values()]
    .map(({ kind, label, count, targets }) => {
      const files = (verb: string): string =>
        targets.size
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
  const preview = text.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)
  return { text: preview, truncated: preview.length < text.length }
}
