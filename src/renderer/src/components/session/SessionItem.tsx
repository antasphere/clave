import { isRemoteKey } from '../../lib/fleet-identity'
import { FleetBadge } from '../fleet/FleetControls'
import { memo } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@clave/ui/components'
import { useSessionStore, type Session } from '../../store/session-store'
import { useLocationStore } from '../../store/location-store'
import {
  CheckCircleIcon,
  EnvelopeIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  QuestionMarkCircleIcon,
  WindowIcon
} from '@heroicons/react/24/outline'
import { ClaudeVariantGlyph } from '../icons/cli-logos'
import { SidebarTabItem } from './SidebarTabItem'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  claudeUsageForModel
} from '../../store/usage-store'
import { isExhausted } from '../../lib/account-pool'
import { accountProviderOf, sessionAccountId } from '../../lib/switch-account'
import { tabIndicators, tabStatusPresentation, type TabGlyph } from '../../lib/tab-status'
import { AccountMenuHeader } from '../layout/AccountMenuHeader'
import { useMarkPack } from '../plugins/native-marks'
import { tokenColor } from '../../lib/marks'
import { SubagentMenu, type SessionMenuEvent } from './SubagentMenu'

/** A warning on a row whose account is about to stop it (ADR 0002), before
 *  the next turn fails. Hovering shows the account card the tab's context menu
 *  opens with. Its own component, subscribed to the usage mirror, because the
 *  row itself only re-renders on its session object. */
function AccountLimitBadge({ session }: { session: Session }): React.JSX.Element | null {
  const provider = accountProviderOf(session)
  const accountId = provider ? sessionAccountId(session, provider) : ''
  const claude = useClaudeAccountsUsage((s) => s.byAccount[accountId])
  const codex = useCodexAccountsUsage((s) => s.byAccount[accountId])
  const summary =
    provider === 'codex'
      ? codex
      : provider === 'claude'
        ? claudeUsageForModel(claude, session.model)
        : undefined
  if (isRemoteKey(session.id) || !provider || !session.alive || !isExhausted(summary)) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="tab-limit-warning"
          data-account-limit={accountId}
          aria-label="This account is at its limit"
        >
          <ExclamationTriangleIcon />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        <AccountMenuHeader session={session} />
        <div className="mt-1.5 text-text-tertiary">
          At its limit. Right-click the tab to switch it to another account.
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function LocationBadge({ locationId }: { locationId: string }): React.JSX.Element | null {
  const location = useLocationStore((s) => s.locations.find((l) => l.id === locationId))
  if (!location || location.type !== 'remote') return null
  return (
    <span
      className="badge flex-shrink-0 bg-surface-100 text-text-tertiary truncate max-w-[120px]"
      title={location.name}
    >
      {location.name}
    </span>
  )
}

// Distinguish `claude agents` without touching the brand logo: a faint
// trailing glyph after the name. Plain Claude Code stays unmarked as the
// baseline; skip-permissions gets no glyph.
function getClaudeVariant(session: Session): 'agents' | null {
  if (session.sessionType === 'agent') return null
  if (session.claudeAgentsMode) return 'agents'
  return null
}

/** Whether the row is an agent's (a provider session): the rows the Appearance
 *  page's agent mark pack draws on. Never a plain terminal, never an OpenClaw
 *  remote agent; a remote provider session counts, as its logo once did. */
function isProviderRow(session: Session): boolean {
  return (
    session.sessionType !== 'agent' &&
    !!(
      session.antigravityMode ||
      session.codexMode ||
      session.piMode ||
      session.claudeMode ||
      session.claudeAgentsMode
    )
  )
}

const GLYPHS: Record<Exclude<TabGlyph, 'spinner'>, typeof CheckCircleIcon> = {
  check: CheckCircleIcon,
  envelope: EnvelopeIcon,
  minus: MinusCircleIcon,
  question: QuestionMarkCircleIcon
}

/** The row's status, in the trailing slot (PRDCT-3933): one glyph from
 *  `tabStatusPresentation`, the same signal the provider logo used to carry
 *  before the title, now on the right where the eye looks for it. The slot
 *  stays when there is nothing to say, so the badges before it keep their
 *  column. Background work is the row's counter, never the glyph's.
 *  Appearance → Agent mark: a plugin's mark pack stands in for the glyph on
 *  an agent row (never on a plain terminal). Its mark moves while the agent
 *  works and takes the status colour as its ink, so the row keeps saying the
 *  same things in a different voice. */
function SessionStatus({ session }: { session: Session }): React.JSX.Element {
  const { status, glyph, tone, label } = tabStatusPresentation(session)
  const pack = useMarkPack()
  const Mark = pack && isProviderRow(session) ? pack.Agent : null
  const markInk =
    status === 'needs-you'
      ? tokenColor('--color-status-waiting')
      : status === 'unread'
        ? tokenColor('--color-status-working')
        : undefined
  const Glyph = glyph && glyph !== 'spinner' ? GLYPHS[glyph] : null
  return (
    <span
      className="sidebar-tab-status"
      data-status={status}
      data-tone={tone}
      data-glyph={Mark ? undefined : (glyph ?? undefined)}
      data-mark={Mark ? 'pack' : undefined}
      title={label ?? undefined}
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
    >
      {Mark ? (
        <Mark working={status === 'working'} status={status} color={markInk} slot="tab" />
      ) : glyph === 'spinner' ? (
        <span className="sidebar-tab-spinner" />
      ) : Glyph ? (
        <Glyph />
      ) : null}
    </span>
  )
}

/** A row carrying an attached web view (session.view) gets the way to it
 *  beside its status: the glyph grows on hover and a click shows the view in
 *  the main pane, while a click anywhere else on the row still shows the
 *  terminal. A span, not a button — the row is already a button. */
function SessionViewButton({ session }: { session: Session }): React.JSX.Element | null {
  const view = session.view
  if (!view) return null
  const openView = (e: React.SyntheticEvent): void => {
    e.stopPropagation()
    useSessionStore.getState().openSessionView(session.id)
  }
  const label = view.title || 'Open view'
  return (
    <span
      className="sidebar-tab-view"
      data-view=""
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      onClick={openView}
      onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        // The glyph sits inside the row's button: without this, the browser
        // turns the same Enter or Space into a click on the row, which shows
        // the terminal again right after the view opened (verifier, round 1).
        e.preventDefault()
        openView(e)
      }}
    >
      <WindowIcon />
    </span>
  )
}

/** Background shells and subagents a turn left running, in words on the row's
 *  right, so a finished tab with a server up still reads as finished. */
function BackgroundCounter({ session }: { session: Session }): React.JSX.Element | null {
  const { background } = tabIndicators(session)
  if (!background) return null
  return (
    <span
      className="tab-background-count"
      data-background={background}
      title={`${background} ${background === 1 ? 'task' : 'tasks'} still running in the background`}
    >
      {background} running
    </span>
  )
}

interface SessionItemProps {
  session: Session
  isSelected: boolean
  onClick: (modifiers: { metaKey: boolean; shiftKey: boolean }) => void
  onContextMenu: (e: React.MouseEvent) => void
  grouped?: boolean
  groupSelected?: boolean
  groupColorHex?: string
  dimmed?: boolean
  forceEditing?: boolean
  onEditingDone?: () => void
  onPointerDown?: (e: React.PointerEvent) => void
  isDragging?: boolean
  onDelete?: () => void
  subagents?: Session[]
  selectedIds?: string[]
  focusedId?: string | null
  onSelectSubagent?: (id: string) => void
  onSubagentContextMenu?: (event: SessionMenuEvent, id: string) => void
}

function SessionItemImpl({
  session,
  isSelected,
  onClick,
  onContextMenu,
  grouped,
  groupSelected,
  groupColorHex,
  dimmed,
  forceEditing,
  onEditingDone,
  onPointerDown,
  isDragging,
  onDelete,
  subagents,
  selectedIds,
  focusedId,
  onSelectSubagent,
  onSubagentContextMenu
}: SessionItemProps): React.JSX.Element {
  const renameSession = useSessionStore((s) => s.renameSession)

  return (
    <SidebarTabItem
      id={session.id}
      name={session.name}
      title={session.cwd.replace(/^\/Users\/[^/]+/, '~')}
      isSelected={isSelected}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onRename={renameSession}
      onDelete={onDelete}
      rowControl={
        subagents?.length && onSelectSubagent ? (
          <SubagentMenu
            parent={session}
            descendants={subagents}
            selectedIds={selectedIds ?? []}
            focusedId={focusedId ?? null}
            onSelect={onSelectSubagent}
            onContextMenu={onSubagentContextMenu}
          />
        ) : undefined
      }
      extraContent={
        <>
          <BackgroundCounter session={session} />
          <AccountLimitBadge session={session} />
          {session.locationId && session.sessionType !== 'local' ? (
            <LocationBadge locationId={session.locationId} />
          ) : getClaudeVariant(session) ? (
            <ClaudeVariantGlyph variant={getClaudeVariant(session)!} />
          ) : null}
          <FleetBadge sessionId={session.id} />
          <SessionViewButton session={session} />
          <SessionStatus session={session} />
        </>
      }
      grouped={grouped}
      groupSelected={groupSelected}
      groupColorHex={groupColorHex}
      dimmed={dimmed}
      forceEditing={forceEditing}
      onEditingDone={onEditingDone}
      onPointerDown={onPointerDown}
      isDragging={isDragging}
    />
  )
}

// The Sidebar passes fresh inline callbacks on every render, but they are thin
// wrappers over stable, live-state-reading handlers, so comparing only the data
// object and scalar props (and ignoring the functions) is safe. This stops a row
// from re-rendering when an unrelated session's status flips.
export const SessionItem = memo(SessionItemImpl, (prev, next) => {
  return (
    prev.session === next.session &&
    prev.isSelected === next.isSelected &&
    prev.grouped === next.grouped &&
    prev.groupSelected === next.groupSelected &&
    prev.groupColorHex === next.groupColorHex &&
    prev.dimmed === next.dimmed &&
    prev.forceEditing === next.forceEditing &&
    prev.isDragging === next.isDragging &&
    prev.subagents === next.subagents &&
    prev.selectedIds === next.selectedIds &&
    prev.focusedId === next.focusedId
  )
})
