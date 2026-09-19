import type { ConversationSnapshot, ConversationTool } from '../../../shared/agent-session'

type Entry = ConversationSnapshot['entries'][number]
export interface ToolGroup {
  kind: 'tool-group'
  id: string
  tools: ConversationTool[]
}

/** Messages end a tool run. Artifacts stay visible alongside its dropdown. */
export function groupConversationEntries(
  entries: Entry[]
): (Exclude<Entry, ConversationTool> | ToolGroup)[] {
  const result: (Exclude<Entry, ConversationTool> | ToolGroup)[] = []
  let group: ToolGroup | undefined
  for (const entry of entries) {
    if (entry.kind === 'tool') {
      if (!group) {
        group = { kind: 'tool-group', id: entry.id, tools: [] }
        result.push(group)
      }
      group.tools.push(entry)
    } else {
      result.push(entry)
      if (entry.kind === 'message') group = undefined
    }
  }
  return result
}

type ToolKind = 'read' | 'search' | 'edit' | 'command' | 'other'
interface Section {
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

function parse(text?: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
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
  for (const key of keys)
    if (typeof data[key] === 'number' && Number.isFinite(data[key])) return data[key] as number
  return undefined
}

/** Plain text content blocks are common to several tools; other data stays readable JSON. */
function content(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(content).filter(Boolean).join('\n')
  const data = record(value)
  if (typeof data.text === 'string') return data.text
  if (data.content !== undefined) return content(data.content)
  if (typeof data.stdout === 'string' || typeof data.stderr === 'string')
    return [data.stdout, data.stderr].filter((v) => typeof v === 'string' && v).join('\n')
  return JSON.stringify(value, null, 2)
}

export function describeTool(tool: ConversationTool): ToolDescription {
  const name = tool.name.toLowerCase().replace(/[\s_-]/g, '')
  const kind: ToolKind = ['read', 'readfile'].includes(name)
    ? 'read'
    : ['grep', 'glob', 'search', 'searchfiles', 'find', 'websearch', 'ripgrep'].includes(name)
      ? 'search'
      : ['edit', 'write', 'writefile', 'applypatch', 'filechange', 'multiedit'].includes(name)
        ? 'edit'
        : ['bash', 'shell', 'commandexecution', 'execcommand', 'runcommand'].includes(name)
          ? 'command'
          : 'other'
  const labels = {
    read: 'Read',
    search: 'Search',
    edit: 'Edit',
    command: 'Shell',
    other: tool.name
  }
  const input = parse(tool.input)
  const data = record(input)
  const path = field(data, 'file_path', 'filePath', 'path', 'filename')
  const query = field(data, 'pattern', 'query', 'glob')
  const command = field(data, 'command', 'cmd')
  const target =
    kind === 'search'
      ? query || (typeof input === 'string' ? input : path)
      : kind === 'command'
        ? command || (typeof input === 'string' ? input : '')
        : path || (typeof input === 'string' ? input : '')
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
  const output = parse(tool.output)
  const exit = numberField(record(output), 'exit_code', 'exitCode')
  if (kind === 'command' && exit !== undefined) detail = `Exit ${exit}`
  const outputText = content(output)
  if (outputText)
    sections.push({
      label: kind === 'read' ? 'Content' : kind === 'search' ? 'Matches' : 'Output',
      text: outputText
    })
  if (!sections.length && !target && tool.input)
    sections.push({ label: 'Input', text: content(input) })
  return { kind, label: labels[kind], target, detail, sections }
}

export function toolGroupSummary(tools: ConversationTool[]): string {
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
    const key = kind === 'other' ? label : kind
    const old = counts.get(key)
    const targets = old?.targets ?? new Set<string>()
    if (target) targets.add(target)
    counts.set(key, { kind, label, count: (old?.count ?? 0) + 1, targets })
  }
  return [...counts.values()]
    .map(({ kind, label, count, targets }) => {
      if (kind === 'read')
        return targets.size
          ? `Read ${targets.size} ${targets.size === 1 ? 'file' : 'files'}`
          : `Read ${count} times`
      if (kind === 'edit')
        return targets.size
          ? `Edited ${targets.size} ${targets.size === 1 ? 'file' : 'files'}`
          : `Edited ${count} times`
      if (kind === 'command') return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`
      if (kind === 'search')
        return `Searched ${count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`}`
      return `${label} × ${count}`
    })
    .join(' · ')
}

export function toolPreview(text: string): { text: string; truncated: boolean } {
  const preview = text.split('\n').slice(0, 8).join('\n').slice(0, 2000)
  return { text: preview, truncated: preview.length < text.length }
}
