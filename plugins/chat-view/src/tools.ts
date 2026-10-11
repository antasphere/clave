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
 *  see. Every view filters through THIS, so all break a run in the same place;
 *  one view used to filter before grouping and another not at all, which split
 *  a run in one view and not the other. */
export function visibleEntries(entries: Entry[]): Entry[] {
  return entries.filter(
    (e) => (e.kind !== 'assistant' || e.text.trim() !== '') && !(e.kind === 'user' && e.withdrawn)
  )
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

export type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'skill' | 'web' | 'agent' | 'other'
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
const SEARCH = ['grep', 'glob', 'search', 'searchfiles', 'find', 'ripgrep']
const EDIT = ['edit', 'write', 'writefile', 'applypatch', 'filechange', 'multiedit']
const COMMAND = ['bash', 'shell', 'commandexecution', 'execcommand', 'runcommand']
const SKILL = ['skill']
const WEB = ['webfetch', 'websearch']
const AGENT = ['task', 'agent']
/** An MCP tool arrives as `mcp__<server>__<tool>`: the reader knows it by the tool. */
const MCP = /^mcp__(.+?)__(.+)$/

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
          : SKILL.includes(name)
            ? 'skill'
            : WEB.includes(name)
              ? 'web'
              : AGENT.includes(name)
                ? 'agent'
                : 'other'
  const labels: Record<ToolKind, string> = {
    read: 'Read',
    search: 'Search',
    edit: 'Edit',
    command: 'Shell',
    skill: 'Skill',
    web: name === 'websearch' ? 'Web search' : 'Fetch',
    agent: 'Agent',
    other: MCP.exec(tool.name ?? '')?.[2] ?? tool.name ?? 'Tool'
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
        : kind === 'skill'
          ? field(data, 'skill', 'name') || literal
          : kind === 'web'
            ? field(data, 'url', 'query') || literal
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
      if (kind === 'skill')
        return count === 1 && targets.size === 1
          ? `Loaded the ${[...targets][0]} skill`
          : `Loaded ${count} skills`
      if (kind === 'web') return `Browsed the web ${times(count)}`
      if (kind === 'agent') return `Ran ${count} ${count === 1 ? 'subagent' : 'subagents'}`
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

/** The verb a row opens with, the way Codex writes it: "Ran npm test". */
export function toolVerb(kind: ToolKind, label: string): string {
  const verbs: Partial<Record<ToolKind, string>> = {
    read: 'Read',
    search: 'Searched',
    edit: 'Edited',
    command: 'Ran',
    skill: 'Loaded skill',
    web: label === 'Web search' ? 'Searched the web for' : 'Fetched',
    agent: 'Ran agent'
  }
  return verbs[kind] ?? label
}
/** The few words a row says on hover: what kind of external call it was. */
export function toolHint(tool: ToolEntry): string {
  const hints: Record<ToolKind, string> = {
    read: 'File read',
    search: 'Search',
    edit: 'File edit',
    command: 'Command run',
    skill: 'Skill loaded',
    web: 'Web request',
    agent: 'Subagent run',
    other: 'Tool call'
  }
  const { kind } = describeToolHead(tool)
  const server = kind === 'other' ? MCP.exec(tool.name ?? '')?.[1] : undefined
  return server ? `Tool call · ${server} MCP` : hints[kind]
}
/** The kind a whole run shows by: its own when every call shares it, a plain
 *  tool call when they differ. */
export function groupKind(tools: ToolEntry[]): ToolKind {
  const kinds = new Set(tools.map((tool) => describeToolHead(tool).kind))
  return kinds.size === 1 ? [...kinds][0] : 'other'
}
export function groupHint(tools: ToolEntry[]): string {
  if (tools.length === 1) return toolHint(tools[0])
  const kind = groupKind(tools)
  const plural: Partial<Record<ToolKind, string>> = {
    read: 'file reads',
    search: 'searches',
    edit: 'file edits',
    command: 'commands run',
    skill: 'skills loaded',
    web: 'web requests',
    agent: 'subagent runs'
  }
  return `${tools.length} ${plural[kind] ?? 'external calls'}`
}
/** The language a section highlights as: a shell line as shell, a change as a
 *  diff, a file by its extension (an unknown one stays plain text). */
export function sectionLanguage(
  kind: ToolKind,
  section: Section,
  path: string
): string | undefined {
  if (kind === 'command') return section.label === 'Command' ? 'bash' : undefined
  if (kind === 'edit') return /^[-+] /m.test(section.text) ? 'diff' : extension(section.label)
  if (kind === 'read' && section.label === 'Content') return extension(path)
  return undefined
}
function extension(path: string): string | undefined {
  return /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
}

/** The Terminal view's title for a run, one sentence whatever its length:
 *  "Read 1 file", "Read 2 files, ran 5 commands". Unlike `toolGroupSummary`, a
 *  lone call is counted like any other, so a run of one and a run of ten read
 *  and open the same way; the call itself is one level down. Parts come in the
 *  order their kind first appears, every call of a kind counted in one part. */
export function runTitle(tools: ToolEntry[]): string {
  const counts = new Map<
    string,
    { kind: ToolKind; count: number; files: Set<string>; named: boolean }
  >()
  for (const tool of tools) {
    const { kind, target } = describeToolHead(tool)
    const entry = counts.get(kind) ?? { kind, count: 0, files: new Set<string>(), named: true }
    entry.count += 1
    if (target) entry.files.add(target)
    else entry.named = false
    counts.set(kind, entry)
  }
  const plural = (n: number, one: string, many = `${one}s`): string =>
    `${n} ${n === 1 ? one : many}`
  const parts = [...counts.values()].map(({ kind, count, files, named }) => {
    // A file read or edited twice is still one file; a call that named no file
    // makes the part count calls, so it never claims fewer files than there were.
    const onFiles = (verb: string): string =>
      named ? `${verb} ${plural(files.size, 'file')}` : `${verb} ${plural(count, 'time')}`
    switch (kind) {
      case 'read':
        return onFiles('read')
      case 'edit':
        return onFiles('edited')
      case 'command':
        return `ran ${plural(count, 'command')}`
      case 'search':
        return `ran ${plural(count, 'search', 'searches')}`
      case 'skill':
        return `loaded ${plural(count, 'skill')}`
      case 'web':
        return `made ${plural(count, 'web request')}`
      case 'agent':
        return `ran ${plural(count, 'subagent')}`
      default:
        return `used ${plural(count, 'tool')}`
    }
  })
  const sentence = parts.join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}
