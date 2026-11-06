import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef, useState } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  QuestionMarkCircleIcon,
  UserGroupIcon
} from '@heroicons/react/24/outline'
import type { WorkChange, WorkRole } from '@clave/contract/work-rules'
import type { Session } from '../../store/session-types'
import type { WorkEntry } from '../../lib/work-presentation'
import { tabIndicators } from '../../lib/tab-status'
import { subagentAttention } from '../../lib/subagent-presentation'
import {
  ROLE_LABEL,
  STANDING_LABEL,
  breadcrumbOf,
  unresolvedWords,
  vacantWords,
  workStateLabel
} from '../../lib/work-words'
import { SidebarTabItem } from './SidebarTabItem'
import { SessionStatus } from './SessionItem'
import type { SessionMenuEvent } from './SubagentMenu'

/**
 * A wave or a lane in the sidebar (PRDCT-4123): one stable row for a unit of
 * work, whatever sessions have held it. The row reads the unit's label, the
 * status of the session that holds it in the usual slot, and a chip when the
 * unit is unresolved, being handed over, completed, or has no owner among
 * this window's sessions; a click goes to the holder, or opens the summary
 * when nobody holds it. The menu beside it lists every session of the unit by
 * role, the agents they spawned, the handovers waiting and the history, and
 * offers the person the two ways to settle an unresolved unit. Nothing here
 * closes a process or reads a title. Its words are `lib/work-words.ts`.
 */

/** A pending handover of the unit's own role, while its holder still holds it. */
function handingOver(entry: WorkEntry): boolean {
  return entry.owner.state === 'held' && entry.pending.some((p) => p.role === entry.ownerRole)
}

function EntryStatus({
  entry,
  sessionsById
}: {
  entry: WorkEntry
  sessionsById: ReadonlyMap<string, Session>
}): React.JSX.Element {
  const holder = entry.target ? sessionsById.get(entry.target) : undefined
  if (holder) return <SessionStatus session={holder} />
  const words = unresolvedWords(entry)
  if (words)
    return (
      <span
        className="sidebar-tab-status"
        data-status="needs-you"
        data-tone="amber"
        data-glyph="question"
        data-work-status="unresolved"
        title={words}
        role="img"
        aria-label={words}
      >
        <QuestionMarkCircleIcon />
      </span>
    )
  const vacant = vacantWords(entry)
  if (vacant)
    return (
      <span
        className="sidebar-tab-status"
        data-work-status="vacant"
        title={vacant}
        role="img"
        aria-label={vacant}
      />
    )
  return <span className="sidebar-tab-status" aria-hidden="true" />
}

function EntryChips({ entry }: { entry: WorkEntry }): React.JSX.Element {
  return (
    <>
      {entry.kind === 'wave' && (
        <span className="badge work-chip" data-chip="wave">
          Wave
        </span>
      )}
      {entry.owner.state === 'unresolved' ? (
        <span className="badge work-chip" data-chip="unresolved" data-tone="amber">
          Unresolved
        </span>
      ) : entry.owner.state === 'completed' ? (
        <span className="badge work-chip" data-chip="completed">
          Completed
        </span>
      ) : entry.owner.state === 'vacant' ? (
        <span className="badge work-chip" data-chip="no-owner">
          {`No ${ROLE_LABEL[entry.ownerRole].toLowerCase()}`}
        </span>
      ) : handingOver(entry) ? (
        <span className="badge work-chip" data-chip="handing-over">
          Handing over
        </span>
      ) : null}
    </>
  )
}

export interface WorkEntryItemProps {
  entry: WorkEntry
  sessionsById: ReadonlyMap<string, Session>
  isSelected: boolean
  selectedIds: string[]
  focusedId: string | null
  /** Show one session of the unit (a click on the row, a menu item). */
  onActivate: (id: string, modifiers: { metaKey: boolean; shiftKey: boolean }) => void
  /** A session's own context menu, as its row would open it. */
  onSessionContextMenu: (event: SessionMenuEvent, id: string) => void
  grouped?: boolean
  groupSelected?: boolean
  groupColorHex?: string
  dimmed?: boolean
  onPointerDown?: (e: React.PointerEvent) => void
  isDragging?: boolean
}

export function WorkEntryItem(props: WorkEntryItemProps): React.JSX.Element {
  const { entry, sessionsById } = props
  const [open, setOpen] = useState(false)
  const holder = entry.target ? sessionsById.get(entry.target) : undefined
  const words = unresolvedWords(entry) ?? vacantWords(entry)
  const title = [
    breadcrumbOf(entry),
    holder ? `${ROLE_LABEL[entry.ownerRole]}: ${holder.name}` : (words ?? null)
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      className="work-entry"
      data-work-unit={entry.unit}
      data-work-kind={entry.kind}
      data-work-owner={entry.owner.state}
      data-work-target={entry.target ?? undefined}
    >
      <SidebarTabItem
        id={entry.anchor}
        name={entry.label}
        title={title}
        isSelected={props.isSelected}
        renameable={false}
        onRename={() => {}}
        onClick={(modifiers) => {
          if (entry.target) props.onActivate(entry.target, modifiers)
          else setOpen(true)
        }}
        onContextMenu={(e) => {
          if (entry.target) props.onSessionContextMenu(e, entry.target)
          else {
            e.preventDefault()
            setOpen(true)
          }
        }}
        rowControl={
          <WorkMenu
            entry={entry}
            sessionsById={sessionsById}
            selectedIds={props.selectedIds}
            focusedId={props.focusedId}
            open={open}
            onOpenChange={setOpen}
            onSelect={(id) => props.onActivate(id, { metaKey: false, shiftKey: false })}
            onContextMenu={props.onSessionContextMenu}
          />
        }
        extraContent={
          <>
            <EntryChips entry={entry} />
            <EntryStatus entry={entry} sessionsById={sessionsById} />
          </>
        }
        grouped={props.grouped}
        groupSelected={props.groupSelected}
        groupColorHex={props.groupColorHex}
        dimmed={props.dimmed}
        onPointerDown={props.onPointerDown}
        isDragging={props.isDragging}
      />
    </div>
  )
}

interface MenuMember {
  session: Session
  hint: string
  role?: WorkRole
  standing?: string
}

function WorkMenu({
  entry,
  sessionsById,
  selectedIds,
  focusedId,
  open,
  onOpenChange,
  onSelect,
  onContextMenu
}: {
  entry: WorkEntry
  sessionsById: ReadonlyMap<string, Session>
  selectedIds: string[]
  focusedId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
  onContextMenu: (event: SessionMenuEvent, id: string) => void
}): React.JSX.Element {
  const openingContext = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const nameOf = (id: string | undefined): string =>
    (id && sessionsById.get(id)?.name) || 'a closed tab'
  const at = (id: string): Session | undefined => sessionsById.get(id)
  const ownerWord = ROLE_LABEL[entry.ownerRole]

  // Everyone the entry stands for, the holder excepted: whose news shows on
  // the trigger, so a verifier waiting on the person is never silent.
  const memberSessions = entry.members.map(at).filter((s): s is Session => !!s)
  const everyone = [...memberSessions, ...entry.agents]
  const others = everyone.filter((s) => s.id !== entry.target)
  const attention = subagentAttention(others)
  const waiting = everyone.filter((s) => tabIndicators(s).status === 'needs-you')
  const focused = everyone.find((s) => s.id === focusedId && s.id !== entry.target)
  const focusedRole = focused?.work ? ROLE_LABEL[focused.work.role] : focused ? 'Agent' : null
  const label =
    focusedRole ?? `${everyone.length} ${everyone.length === 1 ? 'session' : 'sessions'}`
  const alert = attention.sessions.map((s) => `${s.name}: ${workStateLabel(s)}`).join('; ')

  const act = (id: string, change: WorkChange): void => {
    setError(null)
    void window.electronAPI
      .sessionsChangeWork(id, change)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const showContext = (event: SessionMenuEvent, id: string): void => {
    openingContext.current = true
    onOpenChange(false)
    onContextMenu(event, id)
  }

  const member = (m: MenuMember): React.JSX.Element => (
    <DropdownMenu.Item
      key={`${m.session.id}-${m.role ?? 'agent'}`}
      className="menu-item chat-model-option"
      data-work-member={m.session.id}
      data-work-role={m.role ?? 'agent'}
      data-work-standing={m.standing ?? 'current'}
      data-selected={selectedIds.includes(m.session.id) ? 'true' : undefined}
      aria-current={selectedIds.includes(m.session.id) ? 'true' : undefined}
      textValue={m.session.name}
      onSelect={() => onSelect(m.session.id)}
      onContextMenu={(event) => showContext(event, m.session.id)}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          showContext(
            { preventDefault: () => {}, clientX: rect.right, clientY: rect.top },
            m.session.id
          )
        }
      }}
    >
      <span className="chat-model-option-text">
        <span className="truncate">{m.session.name}</span>
        <span className="chat-model-option-hint">{m.hint}</span>
      </span>
      {selectedIds.includes(m.session.id) && (
        <CheckIcon className="select-option-check" aria-hidden="true" />
      )}
    </DropdownMenu.Item>
  )

  const action = (key: string, text: string, run: () => void): React.JSX.Element => (
    <DropdownMenu.Item
      key={key}
      className="menu-item work-menu-action"
      data-work-action={key}
      onSelect={(event) => {
        // Kept open: the unit's new state arrives from the server and the
        // menu shows it, or the refusal in the server's own words.
        event.preventDefault()
        run()
      }}
    >
      {text}
    </DropdownMenu.Item>
  )

  const holding = (role: WorkRole, title: string): React.JSX.Element[] => {
    const h = role === entry.ownerRole ? entry.owner : entry.reviewer
    const out: React.JSX.Element[] = []
    // A unit with no verifier is a normal state between rounds and says
    // nothing; one with no owner in this window says so, and why it may be.
    if (h.state === 'vacant' && role !== entry.ownerRole) return out
    out.push(
      <DropdownMenu.Label key={`${role}-label`} className="menu-label">
        {title}
      </DropdownMenu.Label>
    )
    if (h.state === 'vacant') {
      out.push(
        <DropdownMenu.Item
          key={`${role}-vacant`}
          className="menu-item menu-item--muted"
          data-work-vacant=""
          disabled
        >
          {vacantWords(entry)}
        </DropdownMenu.Item>
      )
      return out
    }
    if (h.state === 'held' || h.state === 'completed') {
      const s = at(h.id)
      if (s)
        out.push(
          member({
            session: s,
            role,
            standing: h.state === 'completed' ? 'completed' : 'current',
            hint: h.state === 'completed' ? `Completed · ${workStateLabel(s)}` : workStateLabel(s)
          })
        )
      return out
    }
    // Unresolved: what disagrees, then the person's choices.
    out.push(
      <DropdownMenu.Item
        key={`${role}-why`}
        className="menu-item menu-item--muted"
        data-work-unresolved={h.reason}
        disabled
      >
        {role === entry.ownerRole ? (unresolvedWords(entry) ?? 'Unresolved') : 'Unresolved'}
      </DropdownMenu.Item>
    )
    for (const id of h.candidates) {
      const s = at(id)
      if (!s) continue
      const standing = s.work?.standing ?? 'current'
      out.push(
        member({
          session: s,
          role,
          standing,
          hint: `${STANDING_LABEL[standing] ?? standing} · ${workStateLabel(s)}`
        })
      )
      out.push(
        standing === 'pending'
          ? action(`accept-${id}`, `Complete the handover to ${s.name}`, () =>
              act(id, { type: 'accept' })
            )
          : action(
              `make-${role}-${id}`,
              `Make ${s.name} the ${ROLE_LABEL[role].toLowerCase()}`,
              () => act(id, { type: 'assign', work: { unit: entry.unit, role }, replace: true })
            )
      )
    }
    return out
  }

  const pendingWhileHeld = entry.pending.filter(
    (p) =>
      !(entry.owner.state === 'unresolved' && entry.owner.candidates.includes(p.id)) &&
      !(entry.reviewer.state === 'unresolved' && entry.reviewer.candidates.includes(p.id))
  )

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger work-trigger"
          data-status={attention.status}
          data-active={focused ? 'true' : undefined}
          aria-label={`Sessions of ${entry.label}${focused ? `, selected ${focused.name}` : ''}${alert ? `; ${alert}` : ''}`}
          title={`${breadcrumbOf(entry)} · ${label}${alert ? ` · ${alert}` : ''}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {attention.status !== 'idle' && (
            <span className="tab-status relative" data-status={attention.status} aria-hidden="true">
              <UserGroupIcon />
            </span>
          )}
          <span className="chat-model-trigger-label">{label}</span>
          <ChevronDownIcon aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu subagent-menu work-menu z-50"
          aria-label={`Sessions of ${entry.label}`}
          onFocusOutside={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (openingContext.current) {
              event.preventDefault()
              openingContext.current = false
            }
          }}
        >
          <DropdownMenu.Label className="menu-label work-menu-breadcrumb">
            {breadcrumbOf(entry)}
          </DropdownMenu.Label>
          {waiting.length > 0 && (
            <>
              <DropdownMenu.Label className="menu-label">Waiting on you</DropdownMenu.Label>
              {waiting.map((s) =>
                member({
                  session: s,
                  role: s.work?.role,
                  standing: s.work?.standing,
                  hint: `${s.work ? ROLE_LABEL[s.work.role] : 'Agent'} · Waiting on you`
                })
              )}
            </>
          )}
          {holding(entry.ownerRole, ownerWord)}
          {pendingWhileHeld.length > 0 && (
            <>
              <DropdownMenu.Label className="menu-label">Taking over</DropdownMenu.Label>
              {pendingWhileHeld.flatMap((p) => {
                const s = at(p.id)
                if (!s) return []
                return [
                  member({
                    session: s,
                    role: p.role,
                    standing: 'pending',
                    hint: `${ROLE_LABEL[p.role]} · from ${nameOf(p.from)} · ${workStateLabel(s)}`
                  }),
                  action(`accept-${p.id}`, `Complete the handover to ${s.name}`, () =>
                    act(p.id, { type: 'accept' })
                  )
                ]
              })}
            </>
          )}
          {holding('verifier', 'Verifier')}
          {entry.workers.length > 0 && (
            <>
              <DropdownMenu.Label className="menu-label">Workers</DropdownMenu.Label>
              {entry.workers.flatMap((id) => {
                const s = at(id)
                return s
                  ? [
                      member({
                        session: s,
                        role: 'worker',
                        hint: [s.work?.task, workStateLabel(s)].filter(Boolean).join(' · ')
                      })
                    ]
                  : []
              })}
            </>
          )}
          {entry.agents.length > 0 && (
            <>
              <DropdownMenu.Label className="menu-label">Agents</DropdownMenu.Label>
              {entry.agents.map((s) =>
                member({
                  session: s,
                  hint: `Spawned by ${nameOf(s.spawnedBy)} · ${workStateLabel(s)}`
                })
              )}
            </>
          )}
          {entry.history.length > 0 && (
            <>
              <DropdownMenu.Label className="menu-label">History</DropdownMenu.Label>
              {entry.history.flatMap((item) => {
                const s = at(item.id)
                if (!s) return []
                const fate =
                  item.standing === 'completed'
                    ? 'Completed'
                    : item.successor
                      ? `Handed over to ${nameOf(item.successor)}`
                      : 'Superseded'
                return [
                  member({
                    session: s,
                    role: item.role,
                    standing: item.standing,
                    hint: `${ROLE_LABEL[item.role]} · ${fate} · ${workStateLabel(s)}`
                  })
                ]
              })}
            </>
          )}
          {error && (
            <DropdownMenu.Item className="menu-item menu-item--danger" data-work-error="" disabled>
              {error}
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Where a session sits in its wave and lane, for its pane's header: the
 *  breadcrumb, its role, and its standing when it does not hold the role. */
export function WorkBreadcrumb({ session }: { session: Session }): React.JSX.Element | null {
  const work = session.work
  if (!work) return null
  const crumb = breadcrumbOf({
    label: work.label,
    wave: work.wave ? { unit: work.wave, label: work.waveLabel ?? work.wave } : undefined
  })
  const standing =
    work.standing === 'current'
      ? ''
      : ` (${work.standing === 'pending' ? 'taking over' : work.standing})`
  const text = `${crumb} · ${ROLE_LABEL[work.role]}${standing}`
  return (
    <span className="pane-header-meta work-breadcrumb" data-work-breadcrumb="" title={text}>
      {text}
    </span>
  )
}
