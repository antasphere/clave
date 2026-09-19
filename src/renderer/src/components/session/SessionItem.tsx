import { memo } from 'react'
import { cn } from '@clave/ui/components'
import { useSessionStore, type Session } from '../../store/session-store'
import { useLocationStore } from '../../store/location-store'
import { CommandLineIcon, BoltIcon, RectangleGroupIcon } from '@heroicons/react/24/outline'
import { ClaudeLogo, AntigravityLogo, CodexLogo, PiLogo, ClaudeVariantGlyph } from '../icons/cli-logos'
import { SidebarTabItem } from './SidebarTabItem'

function LocationBadge({ locationId }: { locationId: string }) {
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
function SessionViewIcon({ session }: { session: Session }) {
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

function SessionIcon({ session }: { session: Session }) {
  // Provider sessions show their brand mark; plain terminals keep the terminal icon.
  // OpenClaw remote agents use the bolt. The local Claude variants share the Claude mark
  // (the trailing glyph tells them apart). Remote sessions reuse the same provider marks —
  // the location badge already signals "remote".
  const Icon = session.sessionType === 'agent'
    ? BoltIcon
    : session.antigravityMode
      ? AntigravityLogo
      : session.codexMode
        ? CodexLogo
        : session.piMode
          ? PiLogo
        : (session.claudeMode || session.claudeAgentsMode)
          ? ClaudeLogo
          : CommandLineIcon

  // Lifecycle-aware providers share these complementary status visuals:
  // the ICON color carries "is it running" and the DOT carries "does it need me".
  //   working → blue pulsing icon, no dot
  //   blocked → neutral icon, amber dot (waiting on a permission/selection prompt)
  //   done & unseen → neutral icon, green dot (finished while you were away; clears on view)
  //   idle / done-seen / empty → neutral icon, no dot
  //   ended → dimmed icon, no dot
  // Antigravity/terminals/agents have no deterministic state signal, so they stay
  // fully neutral — no color, no dot (see ROADMAP.md).
  const isClaudeCode = session.claudeMode === true && !session.claudeAgentsMode &&
    !session.antigravityMode && !session.codexMode && !session.piMode && session.sessionType === 'local'
  const isCodex = session.codexMode === true && session.sessionType === 'local'
  const hasLifecycleState = isClaudeCode || isCodex || (session.piMode === true && session.sessionType === 'local')

  const state = !session.alive ? 'ended' : session.agentState ?? 'idle'
  const working = hasLifecycleState && state === 'working'
  const blocked = (isClaudeCode || isCodex) && state === 'blocked'
  const doneUnseen = hasLifecycleState && state === 'done' && session.hasUnseenActivity
  const ended = hasLifecycleState && state === 'ended'

  // A pending cross-tab message (accent dot) is provider-agnostic and takes
  // precedence over the Claude-only status dots — it's an explicit "another
  // agent wrote here" signal the user hasn't seen yet.
  const injectedFrom = session.injectedFrom
  const dotColor = injectedFrom
    ? 'bg-accent'
    : blocked
      ? 'bg-status-waiting'
      : doneUnseen
        ? 'bg-status-ready'
        : null

  return (
    <span
      className="sidebar-tab-icon relative flex-shrink-0"
      title={injectedFrom ? `Message from ${injectedFrom}` : undefined}
      style={working ? { animation: 'pulse-dot 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite' } : undefined}
    >
      <Icon
        className={cn(
          'transition-colors duration-300',
          working && 'text-status-working',
          ended && 'text-text-tertiary opacity-50'
        )}
      />
      {dotColor && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-surface-50',
            dotColor
          )}
        />
      )}
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
}: SessionItemProps) {
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
        session.view || (session.locationId && session.sessionType !== 'local') || getClaudeVariant(session)
          ? (
              <>
                {session.view ? <SessionViewIcon session={session} /> : null}
                {session.locationId && session.sessionType !== 'local'
                  ? <LocationBadge locationId={session.locationId} />
                  : getClaudeVariant(session)
                    ? <ClaudeVariantGlyph variant={getClaudeVariant(session)!} />
                    : null}
              </>
            )
          : undefined
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
