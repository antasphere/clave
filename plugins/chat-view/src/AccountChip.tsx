import { useRef, useState } from 'react'
import * as DropdownMenu from '@clave/ui/primitives/dropdown-menu'
import { BoltIcon, ExclamationTriangleIcon, MapPinIcon } from '@heroicons/react/24/outline'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'
import {
  headroomWindow,
  capLevel,
  capName,
  capOutLabel,
  capStatus,
  claudeUsageForModel
} from '../../../src/renderer/src/store/usage-store'
import {
  accountProviderOf,
  sessionSwitchTargets,
  switchModeLabel,
  switchSessionAccount
} from '../../../src/renderer/src/lib/switch-account'
import {
  ownAccountFrom,
  useSessionAccountView
} from '../../../src/renderer/src/lib/session-accounts'
import { effectiveSwitchMode } from '../../../src/renderer/src/store/account-policy-store'
import { useSessionConnection } from '../../../src/renderer/src/lib/session-connection'
import { AccountMenuHeader } from '../../../src/renderer/src/components/layout/AccountMenuHeader'
import {
  AccountSwitchRow,
  AccountUsagePreview
} from '../../../src/renderer/src/components/layout/AccountSwitchMenu'
import { MenuPreview } from '../../../src/renderer/src/components/ui/ContextMenu'

/**
 * The stored connection a Pi or OpenCode tab runs on (PRDCT-4427), where a
 * Claude tab names its account: its label alone, no usage (a provider key
 * reports none) and no menu (a tab is not moved to another key from here).
 * Nothing for a tab on no stored connection.
 */
export function ConnectionChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const host = useViewSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const connection = useSessionConnection(host)
  if (!connection) return null
  return (
    <span
      className="term-account term-connection"
      data-level="unknown"
      data-connection-chip={connection.id}
    >
      <span
        className="chat-model-trigger"
        aria-label="Connection"
        title={`Connection: ${connection.label}`}
      >
        <span className="term-account-dot" aria-hidden />
        <span className="chat-model-trigger-label">{connection.label}</span>
      </span>
    </span>
  )
}

/**
 * The account chip on the status line: which account the session runs on and
 * how much of it is left, red with a triangle once it is at its limit. It
 * opens the same account menu a tab's right click does, above the bar: the
 * account's caps as columns, every other account with its card beside the
 * highlighted row (picking one restarts the agent there, the conversation
 * resumed), and the tab's pin and switch mode. Nothing for a session that
 * has no account pool (Pi, a remote agent).
 *
 * The accounts and the usage are the tab's OWNER's (`lib/session-accounts.ts`):
 * a tab on a server names that server's account, reads its usage there and
 * moves among that server's accounts. Its pin and its mode hold an agent's
 * ask as on this Mac; the mode is worded for that, since this Mac's policy
 * does not move a server tab at a limit.
 */
export function AccountChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const host = useViewSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const provider = host ? accountProviderOf(host) : null
  // Subscribed: a renamed, added or removed account, or a read that lands,
  // redraws the chip, on this Mac or on the tab's server. A server tab's
  // chip reads the server's settings as it draws (`useSessionAccountView`).
  const view = useSessionAccountView(host, provider)
  const own = host && view ? ownAccountFrom(view, host) : null
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<{ id: string; row: HTMLElement } | null>(null)
  const clearFrame = useRef<number | null>(null)
  if (host && !provider) return <ConnectionChip sessionId={sessionId} />
  if (!host || !provider || !own || !view) return null

  const summary = claudeUsageForModel(view.usage[own.id], host.model)
  const w = headroomWindow(summary)
  // Out: the cap that stops THIS session, named ("Fable out"); a limit the
  // CLI reported that the poll does not show yet reads "Out" alone, since
  // the report carries no cap (PRDCT-4254).
  const stopping = capStatus(summary)?.stopping ?? null
  const exhausted = stopping !== null || !!host.limitReported
  const level = exhausted ? 'critical' : w ? capLevel(w) : 'unknown'
  const left = w ? Math.max(0, Math.round(100 - w.usedPercentage)) : null
  const headroom = stopping
    ? `${capName(stopping)} out`
    : exhausted
      ? 'Out'
      : left !== null
        ? `${left}% left`
        : null
  const title = [
    own.label,
    stopping
      ? capOutLabel(stopping)
      : exhausted
        ? 'out, as its agent reported'
        : w && left !== null
          ? `${left}% of ${capName(w)} left`
          : null,
    'switch account'
  ]
    .filter(Boolean)
    .join(' · ')

  const targets = open && host.alive ? sessionSwitchTargets(host) : []

  const pinned = host.accountPinned === true
  const automatic = effectiveSwitchMode(host) === 'automatic'
  // Focus is the one signal hover and the arrow keys share; a blur is
  // followed at once by the next row's focus, so the card clears a frame
  // later and does not blink between rows.
  const highlight = (id: string, row: HTMLElement | null): void => {
    if (clearFrame.current != null) cancelAnimationFrame(clearFrame.current)
    clearFrame.current = null
    if (row) {
      setActive({ id, row })
      return
    }
    clearFrame.current = requestAnimationFrame(() => {
      clearFrame.current = null
      setActive(null)
    })
  }
  const previewed = active ? targets.find((t) => t.id === active.id) : undefined

  return (
    <span
      className="term-account"
      data-level={level}
      data-account-chip={own.id}
      data-account-owner={view.remote ? view.owner : undefined}
    >
      <DropdownMenu.Root
        modal={false}
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setActive(null)
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button type="button" className="chat-model-trigger" aria-label="Account" title={title}>
            {exhausted ? (
              <ExclamationTriangleIcon className="term-account-alert" aria-hidden />
            ) : (
              <span className="term-account-dot" aria-hidden />
            )}
            <span className="chat-model-trigger-label">{own.label}</span>
            {headroom && <span className="term-account-headroom">{headroom}</span>}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={6}
            className="menu-surface menu-pop term-account-menu z-50"
            aria-label="Account"
          >
            <div className="term-account-head">
              <AccountMenuHeader session={host} chart />
            </div>
            {targets.length > 0 && (
              <>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Label className="menu-label">Switch account</DropdownMenu.Label>
                {targets.map((target) => (
                  <DropdownMenu.Item
                    key={target.id}
                    className="menu-item"
                    aria-label={target.label}
                    onFocus={(e) => highlight(target.id, e.currentTarget)}
                    onBlur={() => highlight(target.id, null)}
                    onSelect={() =>
                      void switchSessionAccount(sessionId, target.id).then((result) => {
                        if (!result.ok) console.error('Account switch failed:', result.error)
                      })
                    }
                  >
                    <AccountSwitchRow target={target} />
                  </DropdownMenu.Item>
                ))}
              </>
            )}
            {host.alive && (
              <>
                <DropdownMenu.Separator className="menu-sep" />
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={() => useSessionStore.getState().setAccountPinned(sessionId, !pinned)}
                >
                  <MapPinIcon className="term-account-item-icon" aria-hidden />
                  {pinned ? 'Unpin from this account' : 'Pin to this account'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={() =>
                    useSessionStore
                      .getState()
                      .setAccountSwitchMode(sessionId, automatic ? 'propose' : 'automatic')
                  }
                >
                  <BoltIcon className="term-account-item-icon" aria-hidden />
                  {switchModeLabel(automatic, view.remote)}
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {open && previewed && active && (
        <MenuPreview row={active.row}>
          <AccountUsagePreview target={previewed} />
        </MenuPreview>
      )}
    </span>
  )
}
