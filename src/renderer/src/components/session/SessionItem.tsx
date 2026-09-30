import { memo } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@clave/ui/components'
import { useSessionStore, type Session } from '../../store/session-store'
import { useLocationStore } from '../../store/location-store'
import {
  CommandLineIcon,
  BoltIcon,
  RectangleGroupIcon,
  ExclamationTriangleIcon
} from '@heroicons/react/24/outline'
import {
  ClaudeLogo,
  AntigravityLogo,
  CodexLogo,
  PiLogo,
  ClaudeVariantGlyph
} from '../icons/cli-logos'
import { SidebarTabItem } from './SidebarTabItem'
import { useClaudeAccountsUsage, useCodexAccountsUsage } from '../../store/usage-store'
import { isExhausted } from '../../lib/account-pool'
import { accountProviderOf, sessionAccountId } from '../../lib/switch-account'
import { tabIndicators } from '../../lib/tab-status'
import { AccountMenuHeader } from '../layout/AccountMenuHeader'

/** A warning on a row whose account is about to stop it (ADR 0002), before
 *  the next turn fails. Hovering shows the account card the tab's context menu
 *  opens with. Its own component, subscribed to the usage mirror, because the
 *  row itself only re-renders on its session object. */
function AccountLimitBadge({ session }: { session: Session }): React.JSX.Element | null {
  const provider = accountProviderOf(session)
  const accountId = provider ? sessionAccountId(session, provider) : ''
  const claude = useClaudeAccountsUsage((s) => s.byAccount[accountId])
  const codex = useCodexAccountsUsage((s) => s.byAccount[accountId])
  const summary = provider === 'codex' ? codex : provider === 'claude' ? claude : undefined
  if (!provider || !session.alive || !isExhausted(summary)) return null
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
// baseline; skip-permissions no longer gets a glyph — its slot is where the
// session view's dashboard icon lives (see SessionViewIcon).
function getClaudeVariant(session: Session): 'agents' | null {
  if (session.sessionType === 'agent') return null
  if (session.claudeAgentsMode) return 'agents'
  return null
}

/** The dashboard icon on a row carrying an attached web view (session.view):
 *  clicking it shows the view in the main pane; clicking the row itself still
 *  shows the terminal. A span, not a button — the row is already a button. */
function SessionViewIcon({ session }: { session: Session }): React.JSX.Element {
  return (
    <span
      role="button"
      tabIndex={0}
      className="flex-shrink-0 text-text-tertiary hover:text-text-primary cursor-pointer"
      title={session.view?.title || 'Open view'}
      onClick={(e) => {
        e.stopPropagation()
        useSessionStore.getState().openSessionView(session.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
          useSessionStore.getState().openSessionView(session.id)
        }
      }}
    >
      <RectangleGroupIcon className="w-3.5 h-3.5" />
    </span>
  )
}

function SessionIcon({ session }: { session: Session }): React.JSX.Element {
  // Provider sessions show their brand mark; plain terminals keep the terminal icon.
  // OpenClaw remote agents use the bolt. The local Claude variants share the Claude mark
  // (the trailing glyph tells them apart). Remote sessions reuse the same provider marks —
  // the location badge already signals "remote".
  const Icon =
    session.sessionType === 'agent'
      ? BoltIcon
      : session.antigravityMode
        ? AntigravityLogo
        : session.codexMode
          ? CodexLogo
          : session.piMode
            ? PiLogo
            : session.claudeMode || session.claudeAgentsMode
              ? ClaudeLogo
              : CommandLineIcon
  // The logo carries one signal at a time (`lib/tab-status.ts`): a ring while
  // it works, amber when it needs the reader, blue when there is something new
  // to read. Background work is the row's counter, never the logo's.
  const { status } = tabIndicators(session)
  return (
    <span
      className="sidebar-tab-icon tab-status relative flex-shrink-0"
      data-status={status}
      title={
        status === 'needs-you'
          ? 'Waiting on you'
          : status === 'working'
            ? 'Working'
            : status === 'unread'
              ? session.injectedFrom
                ? `Message from ${session.injectedFrom}`
                : 'Finished while you were away'
              : undefined
      }
    >
      <Icon />
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
  onDelete
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
      icon={<SessionIcon session={session} />}
      extraContent={
        <>
          {session.view ? <SessionViewIcon session={session} /> : null}
          <BackgroundCounter session={session} />
          <AccountLimitBadge session={session} />
          {session.locationId && session.sessionType !== 'local' ? (
            <LocationBadge locationId={session.locationId} />
          ) : getClaudeVariant(session) ? (
            <ClaudeVariantGlyph variant={getClaudeVariant(session)!} />
          ) : null}
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
    prev.isDragging === next.isDragging
  )
})
