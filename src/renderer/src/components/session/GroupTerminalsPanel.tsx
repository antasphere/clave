import { PlusIcon } from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'
import {
  type GroupTerminalConfig,
  TERMINAL_COLOR_VALUES,
  resolveColorHex
} from '../../store/session-store'
import { getTerminalIconComponent } from '../ui/GroupCommandDialog'

/** The group's terminals, listed one per row inside the header's hover panel:
 *  icon in the terminal's colour, the command it runs, and a dot that says
 *  whether it is running. Click starts or focuses it, right-click edits it,
 *  and the muted row at the foot adds one. The row reads the command because a
 *  terminal has no name yet (PRDCT-1671 adds one; it slots in here). */
export interface GroupTerminalsPanelProps {
  terminals: GroupTerminalConfig[]
  aliveSessionIds: Set<string>
  focusedSessionId: string | null
  onTerminalClick: (terminalId: string) => void
  onTerminalContextMenu: (terminalId: string, e: React.MouseEvent) => void
  onAddTerminal: () => void
}

/** The last path segment of a cwd, for a terminal that runs in a folder of its own. */
function folderOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? null
}

export function GroupTerminalsPanel({
  terminals,
  aliveSessionIds,
  focusedSessionId,
  onTerminalClick,
  onTerminalContextMenu,
  onAddTerminal
}: GroupTerminalsPanelProps): React.JSX.Element {
  const running = terminals.filter((t) => !!t.sessionId && aliveSessionIds.has(t.sessionId)).length
  return (
    <div className="w-[248px] p-1" data-group-terminals-panel>
      <div className="menu-label flex items-center justify-between">
        <span>Terminals</span>
        {terminals.length > 0 && (
          <span className="tabular-nums">
            {running}/{terminals.length} running
          </span>
        )}
      </div>
      {terminals.length === 0 && (
        <div className="px-2 pb-1.5 text-[12px] text-text-tertiary">
          No terminals yet — a saved command this group runs on click.
        </div>
      )}
      {terminals.map((t) => {
        const alive = !!t.sessionId && aliveSessionIds.has(t.sessionId)
        const focused = !!t.sessionId && t.sessionId === focusedSessionId
        const colorHex = resolveColorHex(t.color) ?? TERMINAL_COLOR_VALUES['blue']
        const IconComp = getTerminalIconComponent(t.icon)
        const folder = folderOf(t.cwd)
        return (
          <button
            key={t.id}
            type="button"
            className={cn('menu-item', focused && 'bg-surface-200')}
            data-terminal-row={t.id}
            data-running={alive ? 'true' : undefined}
            onClick={(e) => {
              e.stopPropagation()
              onTerminalClick(t.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onTerminalContextMenu(t.id, e)
            }}
            title={`${t.command || 'Shell'}${alive ? ' (running)' : ''}${t.cwd ? `\n${t.cwd}` : ''}`}
          >
            <span
              className="flex-shrink-0 flex items-center justify-center w-4 h-4"
              style={{ color: colorHex, opacity: alive ? 1 : 0.55 }}
            >
              <IconComp className="w-4 h-4" />
            </span>
            <span className="flex-1 min-w-0 flex flex-col leading-tight">
              <span className="truncate">{t.command || 'Shell'}</span>
              {folder && (
                <span className="truncate text-[11px] font-normal text-text-tertiary">{folder}</span>
              )}
            </span>
            <span
              className="terminal-row-dot flex-shrink-0"
              data-running={alive ? 'true' : undefined}
              style={alive ? { backgroundColor: colorHex } : undefined}
              aria-label={alive ? 'running' : 'stopped'}
            />
          </button>
        )
      })}
      {terminals.length > 0 && <div className="menu-sep" />}
      <button
        type="button"
        className="menu-item menu-item--muted"
        data-add-terminal
        onClick={(e) => {
          e.stopPropagation()
          onAddTerminal()
        }}
      >
        <PlusIcon className="w-3.5 h-3.5 flex-shrink-0" />
        <span>New terminal</span>
      </button>
    </div>
  )
}
