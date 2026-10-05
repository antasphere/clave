import { useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BoltIcon, ExclamationTriangleIcon, MapPinIcon } from '@heroicons/react/24/outline'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'
import {
  useClaudeProfileStore,
  sessionAccount
} from '../../../src/renderer/src/store/claude-profile-store'
import {
  useCodexAccountStore,
  sessionCodexAccount
} from '../../../src/renderer/src/store/codex-account-store'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  headroomWindow,
  capLevel,
  capName
} from '../../../src/renderer/src/store/usage-store'
import { isExhausted } from '../../../src/renderer/src/lib/account-pool'
import {
  accountProviderOf,
  sessionSwitchTargets,
  switchSessionAccount
} from '../../../src/renderer/src/lib/switch-account'
import { effectiveSwitchMode } from '../../../src/renderer/src/store/account-policy-store'
import { AccountMenuHeader } from '../../../src/renderer/src/components/layout/AccountMenuHeader'
import {
  AccountSwitchRow,
  AccountUsagePreview
} from '../../../src/renderer/src/components/layout/AccountSwitchMenu'
import { MenuPreview } from '../../../src/renderer/src/components/ui/ContextMenu'

/**
 * The account chip on the status line: which account the session runs on and
 * how much of it is left, red with a triangle once it is at its limit. It
 * opens the same account menu a tab's right click does, above the bar: the
 * account's caps as columns, every other account with its card beside the
 * highlighted row (picking one restarts the agent there, the conversation
 * resumed), and the tab's pin and switch mode. Nothing for a session that
 * has no account pool (Pi, a remote).
 */
export function AccountChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const host = useViewSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  // Subscribed so a renamed, added or removed account redraws the chip.
  useClaudeProfileStore((s) => s.profiles)
  useCodexAccountStore((s) => s.accounts)
  const provider = host ? accountProviderOf(host) : null
  const own = host
    ? provider === 'codex'
      ? sessionCodexAccount(host)
      : sessionAccount(host)
    : null
  const claudeSummary = useClaudeAccountsUsage((s) => (own ? s.byAccount[own.id] : undefined))
  const codexSummary = useCodexAccountsUsage((s) => (own ? s.byAccount[own.id] : undefined))
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<{ id: string; row: HTMLElement } | null>(null)
  const clearFrame = useRef<number | null>(null)
  if (!host || !provider || !own) return null

  const summary = provider === 'codex' ? codexSummary : claudeSummary
  const w = headroomWindow(summary)
  const exhausted = isExhausted(summary) || host.limitReported === true
  const level = exhausted ? 'critical' : w ? capLevel(w) : 'unknown'
  const left = w ? Math.max(0, Math.round(100 - w.usedPercentage)) : null
  const headroom = exhausted ? 'At limit' : left !== null ? `${left}% left` : null
  const title = [
    own.label,
    exhausted ? 'at its limit' : w && left !== null ? `${left}% of ${capName(w)} left` : null,
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
    <span className="term-account" data-level={level} data-account-chip={own.id}>
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
            collisionPadding={8}
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
                    onSelect={() => void switchSessionAccount(sessionId, target.id)}
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
                  {automatic
                    ? 'Propose switches, do not make them'
                    : 'Switch automatically at limit'}
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
