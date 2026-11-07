/**
 * "Allow Claude to write notes.txt?": the request in the reader's words,
 * when the tool is one the view knows; the provider's own sentence
 * otherwise (the desktop's `describeRequest` in PromptDock.tsx).
 */
import type { Permission } from '../../chat/reducer'
import { describeTool, type ToolKind } from '../../chat/tools'

const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

const VERBS: Record<ToolKind, string> = {
  read: 'read',
  search: 'search',
  edit: 'edit',
  command: 'run a command',
  skill: 'load the skill',
  web: 'fetch',
  agent: 'start a subagent',
  other: 'use'
}

/** "Allow Claude to write notes.txt?" in the reader's words, when the tool
 *  is one the view knows; the provider's own sentence otherwise. */
export function describeRequest(
  request: Permission,
  agent: string
): { title: string; target: string; kind: ToolKind; code?: { text: string; language?: string } } {
  if (!request.toolName) return { title: request.description, target: '', kind: 'other' }
  const tool = describeTool({
    kind: 'tool',
    id: request.id,
    name: request.toolName,
    input: request.input,
    complete: false,
    at: 0
  })
  if (tool.kind === 'other' && !/^mcp__/.test(request.toolName))
    return { title: request.description, target: '', kind: 'other' }
  const verb =
    tool.kind === 'edit' && /write/i.test(request.toolName)
      ? 'write'
      : tool.kind === 'other'
        ? `use ${tool.label}`
        : VERBS[tool.kind]
  const named = tool.kind === 'command' || !tool.target ? '' : ` ${basename(tool.target)}`
  const change = tool.sections.find((s) => s.label !== 'Target' && s.label !== 'Command')
  return {
    title: `Allow ${agent} to ${verb}${named}?`,
    target: tool.kind === 'command' ? '' : tool.target,
    kind: tool.kind,
    code:
      tool.kind === 'command' && tool.target
        ? { text: tool.target, language: 'bash' }
        : change
          ? { text: change.text, language: /^[-+] /m.test(change.text) ? 'diff' : undefined }
          : undefined
  }
}
