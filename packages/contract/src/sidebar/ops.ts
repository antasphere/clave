/**
 * The rules a sidebar layout obeys, pure and shared: the server applies them
 * to the layout it keeps for a window, and the renderer applies the same
 * ones to the copy it edits before the server has answered, so the two never
 * disagree on what a move or a merge produces. No import, no runtime: a
 * preload or a browser page loads this file alone.
 *
 * `ops-move.ts` is the structural edit (drag-and-drop, the explicit ungroup);
 * `ops-merge.ts` is how a window's saved layout is rebuilt around the
 * sessions that survived a restart and how one handed over by another window
 * is taken in. Both came from the renderer's `lib/`, tests and all, when the
 * sidebar moved to the server (PRDCT-3241).
 */
export { moveLayoutItems, type MovePosition, type OpsGroup, type OpsLayout } from './ops-move'
export {
  absorbLayout,
  mergeLayoutForKeys,
  placeAdopted,
  type LayoutGroupLike,
  type LayoutKey,
  type LayoutSessionLike,
  type LayoutSlice
} from './ops-merge'

export interface NormalizedTerminal {
  id: string
  command: string
  commandMode: 'prefill' | 'auto'
  color: string
  icon?: string
  cwd?: string | null
  autoLaunchLocalhost?: boolean
  serverUrl?: string
  groupView?: boolean
  sessionId: string | null
}

export interface NormalizedGroup {
  id: string
  name: string
  sessionIds: string[]
  collapsed: boolean
  cwd: string | null
  terminals: NormalizedTerminal[]
  prompt?: string | null
  rootSession?: boolean
  color?: string | null
  view?: { url: string; title?: string; terminalId?: string | null } | null
  workspaceId?: string
}

export interface NormalizedLayout {
  groups: NormalizedGroup[]
  displayOrder: string[]
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []
const optionalString = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined)

/**
 * A layout as a file or a message may hold it, brought to the shape the
 * contract declares: a group with no id is dropped, every list defaults to
 * empty, a flag to false, and a field of the wrong type to its absence.
 * Lenient on purpose: a layout file was written by every release before this
 * one, and refusing a field it did not know would lose the window's groups
 * at the first boot on the new build without an error anyone sees.
 */
export function normalizeLayout(data: unknown): NormalizedLayout {
  const d = isRecord(data) ? data : {}
  const groups: NormalizedGroup[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(d.groups) ? d.groups : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) continue
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    const group: NormalizedGroup = {
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : 'Group',
      sessionIds: strings(raw.sessionIds),
      collapsed: raw.collapsed === true,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
      terminals: normalizeTerminals(raw.terminals)
    }
    if (typeof raw.prompt === 'string' || raw.prompt === null) group.prompt = raw.prompt
    if (raw.rootSession === true) group.rootSession = true
    if (typeof raw.color === 'string' || raw.color === null) group.color = raw.color
    if (raw.view === null) group.view = null
    else if (isRecord(raw.view) && typeof raw.view.url === 'string') {
      group.view = { url: raw.view.url }
      const title = optionalString(raw.view.title)
      if (title !== undefined) group.view.title = title
      if (typeof raw.view.terminalId === 'string' || raw.view.terminalId === null)
        group.view.terminalId = raw.view.terminalId
    }
    const workspaceId = optionalString(raw.workspaceId)
    if (workspaceId !== undefined) group.workspaceId = workspaceId
    groups.push(group)
  }
  return { groups, displayOrder: [...new Set(strings(d.displayOrder))] }
}

function normalizeTerminals(data: unknown): NormalizedTerminal[] {
  const out: NormalizedTerminal[] = []
  for (const raw of Array.isArray(data) ? data : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) continue
    const terminal: NormalizedTerminal = {
      id: raw.id,
      command: typeof raw.command === 'string' ? raw.command : '',
      commandMode: raw.commandMode === 'auto' ? 'auto' : 'prefill',
      color: typeof raw.color === 'string' ? raw.color : 'black',
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null
    }
    const icon = optionalString(raw.icon)
    if (icon !== undefined) terminal.icon = icon
    if (typeof raw.cwd === 'string' || raw.cwd === null) terminal.cwd = raw.cwd
    if (typeof raw.autoLaunchLocalhost === 'boolean')
      terminal.autoLaunchLocalhost = raw.autoLaunchLocalhost
    const serverUrl = optionalString(raw.serverUrl)
    if (serverUrl !== undefined) terminal.serverUrl = serverUrl
    if (typeof raw.groupView === 'boolean') terminal.groupView = raw.groupView
    out.push(terminal)
  }
  return out
}
