import { isRemoteKey } from '../../lib/fleet-identity'
import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Cog6ToothIcon,
  ArrowDownTrayIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon
} from '@heroicons/react/24/outline'
import type { UsageWindow } from '../../../../preload/index.d'
import { useUserStore } from '../../store/user-store'
import { useSessionStore } from '../../store/session-store'
import { useUpdaterStore } from '../../store/updater-store'
import { useWorkTrackerStore } from '../../store/work-tracker-store'
import { useFeedbackStore } from '../../store/feedback-store'
import {
  claudeUsageStore,
  codexUsageStore,
  piUsageStores,
  accountUsageFieldsOf,
  claudeUsageForModel,
  headroomWindow,
  capName,
  capOutLabel,
  formatReset,
  usageProviderForSession,
  useClaudeAccountsUsage,
  useUsageNavigation,
  USAGE_PROVIDER_LABELS,
  piTodaySummary,
  type UsageProvider
} from '../../store/usage-store'
import { windowExhausted } from '../../lib/account-pool'
import { accountForLaunch, accountProviderOf } from '../../lib/switch-account'
import { ownAccountFrom, useSessionAccountView } from '../../lib/session-accounts'
import { useClaudeProfileStore } from '../../store/claude-profile-store'
import { useCodexAccountStore } from '../../store/codex-account-store'
import { PiLogo } from '../icons/cli-logos'
import { formatDuration } from '../work-tracker/utils'
import { ReleaseNotesBadge } from '../help/ReleaseNotesBadge'
import { UserIconDisplay } from '../ui/UserIconDisplay'
import { BrandField } from '../ui/BrandField'
import { fieldAccent } from '../../lib/brand-field'
import { useSessionConnection } from '../../lib/session-connection'
import { cn } from '@clave/ui/components'
import { useShortcutLabel } from '../../store/keymap-store'

/**
 * "There is an update" — one line, two buttons, and a mark on the icon for
 * what is actually in it.
 *
 * The notes come from the GitHub release bodies over `electron-updater`, which
 * is the only changelog a running app can have for a version it has not
 * installed: `help/whats-new.json` is stamped and bundled at build time, so the
 * note for v1.80 exists solely inside the v1.80 binary. Without them the card
 * asked for a 220 MB download and a restart while naming only a version number.
 *
 * They used to live in a fold under the buttons. That put reference material
 * inside the box holding the decision — opening it grew the card and pushed
 * Later and Update down the sidebar — so they moved out to a panel beside the
 * card, off the badge on the icon (`ReleaseNotesBadge`). The card itself is now
 * one row, always.
 *
 * The badge is absent, not inert, when the provider gave no bodies: a control
 * that opens onto nothing reads as a broken one.
 */
export function UpdateBanner(): React.ReactElement {
  const phase = useUpdaterStore((s) => s.phase)
  const version = useUpdaterStore((s) => s.availableVersion)
  const releaseNotes = useUpdaterStore((s) => s.releaseNotes)
  const dismissed = useUpdaterStore((s) => s.dismissed)
  const startDownload = useUpdaterStore((s) => s.startDownload)
  const dismiss = useUpdaterStore((s) => s.dismiss)

  // No listener here any more: the shell subscribes once and hydrates from the
  // main process, so this banner renders whatever the truth is at mount rather
  // than whatever push it happened to catch.
  const handleUpdate = (): void => {
    startDownload()
  }

  const showUpdateBanner = phase === 'available' && !dismissed

  return (
    <AnimatePresence>
      {showUpdateBanner && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          className="overflow-hidden"
        >
          <div
            data-testid="update-banner"
            className="px-2.5 py-2 rounded-xl bg-accent/8 border border-accent/15"
          >
            {/* One row, always. A full pre-release version fits beside both
                buttons only without a separate mark, so the prompt carries
                none: `v2.0.0-beta.1` names the beta itself, and the mark
                stays where there is room for it, in Software Update. */}
            <div className="flex items-center gap-2">
              <div className="relative flex items-center justify-center w-6 h-6 rounded-md bg-accent/12 flex-shrink-0">
                <ArrowDownTrayIcon className="w-3.5 h-3.5 text-accent" />
                {/* A release published with an empty body normalises to null
                    upstream rather than to an empty array, so this is a real
                    absence, not a blank note. */}
                {releaseNotes && releaseNotes.length > 0 && (
                  <ReleaseNotesBadge notes={releaseNotes} version={version} />
                )}
              </div>
              <p className="text-[12px] font-medium text-text-primary leading-tight whitespace-nowrap">
                {version ? `v${version}` : 'Update'}
              </p>
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={dismiss}
                  className="px-1.5 py-0.5 text-[11px] font-medium text-text-tertiary hover:text-text-secondary rounded-md hover:bg-surface-200 transition-colors"
                >
                  Later
                </button>
                <button
                  onClick={handleUpdate}
                  className="px-2 py-0.5 text-[11px] font-medium text-action-foreground bg-action hover:bg-action-hover rounded-md transition-colors"
                >
                  Update
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * The second line of the foot panel: how much of your agent is left.
 *
 * The cap shown is the one GOVERNING the focused tab's provider and model
 * (PRDCT-4255): the tightest of the tab's own family cap and the shared caps
 * (the weekly all-models cap, the 5-hour block where the plan has one), as
 * the service ranks them, a tie going to the all-models cap. Which caps an
 * account has is the service's business, so nothing here names a kind; the
 * line names the cap it shows (`Fable`, `Overall`, `5h`) so 62% can be told
 * apart between the Fable week and the whole week, and when that cap is out
 * it says so in the one vocabulary: "Fable out · back in 2d 5h".
 *
 * Percent LEFT, not percent used. The old line here counted minutes worked
 * today, which said nothing about whether you could keep going.
 */
function UsageLine({
  window: w,
  provider,
  account
}: {
  window: UsageWindow
  provider: 'claude' | 'codex'
  /** The Claude account's label, shown only once there is more than one. */
  account: string | null
}): React.ReactElement {
  const openSettings = useSessionStore((s) => s.openSettings)

  const left = Math.max(0, Math.round(100 - w.usedPercentage))
  const reset = formatReset(w.resetsAt)
  const out = windowExhausted(w)
  // The service's verdict first where it disagrees with the raw percentage:
  // it is plan-aware and a bare number is not.
  const rank = { normal: 0, warning: 1, critical: 2 }
  const byPct = left <= 10 ? 'critical' : left <= 30 ? 'warning' : 'normal'
  const level = out
    ? 'critical'
    : rank[w.severity ?? 'normal'] >= rank[byPct]
      ? (w.severity ?? 'normal')
      : byPct

  const tone =
    level === 'critical'
      ? 'text-wellbeing-strong'
      : level === 'warning'
        ? 'text-wellbeing-gentle'
        : 'text-text-secondary'

  return (
    <button
      onClick={() => {
        useUsageNavigation.getState().select(provider)
        openSettings('usage')
      }}
      className="sidebar-footer-line"
      data-usage-provider={provider}
      data-usage-account={account ?? undefined}
      data-usage-cap={capName(w)}
      title={[
        USAGE_PROVIDER_LABELS[provider],
        account,
        w.label,
        out ? capOutLabel(w, { reset: 'at' }) : `${left}% left`,
        out ? null : reset
      ]
        .filter(Boolean)
        .join(' · ')}
    >
      <span className="usage-meter" aria-hidden="true">
        <span
          className={cn('usage-meter-fill', `usage-meter-fill--${level}`)}
          style={{ width: `${Math.max(3, left)}%` }}
        />
      </span>
      <span className={cn('text-[11px] font-medium tabular-nums flex-shrink-0', tone)}>
        {out ? capOutLabel(w) : `${left}% left`}
      </span>
      <span className="text-[11px] text-text-tertiary truncate">
        · {provider === 'codex' ? 'Codex' : (account ?? 'Claude')}
        {out ? '' : ` · ${capName(w)}`}
      </span>
    </button>
  )
}

/**
 * What the second line falls back to when there are no limits to show — not
 * signed in, offline, or an account the service says nothing about. Only when
 * there is actually something to say: a tracker reading `0m · 0 sessions` is
 * the meaningless thing the usage line replaced, and repeating it as a fallback
 * would put it straight back.
 */
function WorkLine(): React.ReactElement {
  const todayTotalMinutes = useWorkTrackerStore((s) => s.todayTotalMinutes)
  const todaySessionCount = useWorkTrackerStore((s) => s.todaySessionCount)
  const breakSuggestion = useWorkTrackerStore((s) => s.breakSuggestion)
  const openSettings = useSessionStore((s) => s.openSettings)

  const isStrong = breakSuggestion === 'strong'
  const hasBreak = isStrong || breakSuggestion === 'gentle'
  const tone = hasBreak
    ? isStrong
      ? 'text-wellbeing-strong'
      : 'text-wellbeing-gentle'
    : 'text-text-secondary'

  return (
    <button onClick={() => openSettings('usage')} className="sidebar-footer-line" title="Usage">
      <ClockIcon className={cn('w-3.5 h-3.5 flex-shrink-0', tone)} />
      <span className={cn('text-[11px] font-medium', tone)}>
        {formatDuration(todayTotalMinutes)}
      </span>
      <span className="text-[11px] text-text-tertiary truncate">
        {hasBreak
          ? isStrong
            ? '· take a break'
            : '· break?'
          : `· ${todaySessionCount} session${todaySessionCount !== 1 ? 's' : ''}`}
      </span>
    </button>
  )
}

/**
 * The foot of the sidebar: one panel, the same material as the launcher and the
 * switcher at the top, holding everything that is about *you* rather than about
 * the work — the avatar and name, the day's hours, the way to reach us, and the
 * settings gear.
 *
 * Its ground is the user's own Antasphere field, bled faintly across the whole
 * panel (see .sidebar-footer-field). That is the whole point of the block: the
 * colour you chose is a material the panel is made of, not a 20% wash behind a
 * glyph — and every control in it lights up in that field's own hue rather than
 * in the app's grey, which over a coloured ground reads as dirt (see
 * .sidebar-footer in main.css, and `Palette.accent` in lib/brand-field).
 */
export function SidebarFooter(): React.ReactElement {
  const name = useUserStore((s) => s.name)
  const avatarIcon = useUserStore((s) => s.avatarIcon)
  const avatarField = useUserStore((s) => s.avatarField)
  const avatarSeed = useUserStore((s) => s.avatarSeed)
  const openSettings = useSessionStore((s) => s.openSettings)
  const settingsShortcut = useShortcutLabel('openSettings')
  const settingsTitle = `Settings${settingsShortcut ? ` (${settingsShortcut})` : ''}`

  const phase = useUpdaterStore((s) => s.phase)
  const version = useUpdaterStore((s) => s.availableVersion)
  const dismissed = useUpdaterStore((s) => s.dismissed)
  const undismiss = useUpdaterStore((s) => s.undismiss)

  const provider = useSessionStore((s) =>
    s.focusedSessionId === null
      ? 'claude'
      : isRemoteKey(s.focusedSessionId)
        ? null
        : usageProviderForSession(s.sessions.find((session) => session.id === s.focusedSessionId))
  )
  // The foot follows the focused tab's ACCOUNT and MODEL, not just its
  // provider: a tab on the second subscription reads that subscription's
  // headroom, filtered to the caps its model draws on. With no tab focused,
  // the account the launcher would pick next (the pool's answer over every
  // account's read), on the shared caps alone until a launch's model is
  // known (lane B's resolved default, PRDCT-4256).
  useClaudeProfileStore((s) => s.selectedProfileId)
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const focusedSession = useSessionStore((s) =>
    s.focusedSessionId === null
      ? null
      : (s.sessions.find((session) => session.id === s.focusedSessionId) ?? null)
  )
  // A Pi or OpenCode tab's stored connection, named where a Claude tab's
  // account is (PRDCT-4427).
  const connection = useSessionConnection(focusedSession)
  // Subscribed so the launcher's pick follows the reads as they land.
  useClaudeAccountsUsage((s) => s.byAccount)
  const selectedCodexId = useCodexAccountStore((s) => s.selectedAccountId)
  const codexAccounts = useCodexAccountStore((s) => s.accounts)
  const accountId =
    provider === 'codex'
      ? (focusedSession?.codexAccountId ?? selectedCodexId)
      : (focusedSession?.claudeProfileId ?? accountForLaunch('claude').id)
  const account =
    provider === 'codex'
      ? codexAccounts.find((a) => a.id === accountId)
      : profiles.find((p) => p.id === accountId)
  const many = provider === 'codex' ? codexAccounts.length > 1 : profiles.length > 1
  const sessionLabel =
    provider === 'codex' ? focusedSession?.codexAccountLabel : focusedSession?.claudeProfileLabel
  const sessionAccountRef =
    provider === 'codex' ? focusedSession?.codexAccountId : focusedSession?.claudeProfileId
  // A session whose account was removed keeps the label it started with.
  const accountLabel =
    many && account
      ? account.label
      : !account && sessionAccountRef
        ? (sessionLabel ?? 'Removed account')
        : null
  const quota = provider === 'codex' ? codexUsageStore(accountId)() : claudeUsageStore(accountId)()
  // A tab on a server: its OWN account on that server and that account's
  // read there (PRDCT-4328), the server's settings the chip and the row
  // already keep current. Never this Mac's account of the same id.
  const remoteFocused = focusedSession && isRemoteKey(focusedSession.id) ? focusedSession : null
  const remoteProvider = remoteFocused ? accountProviderOf(remoteFocused) : null
  const remoteView = useSessionAccountView(remoteFocused, remoteProvider)
  const remoteOwn = remoteFocused && remoteView ? ownAccountFrom(remoteView, remoteFocused) : null
  const remoteRead = remoteOwn && remoteView ? remoteView.usage[remoteOwn.id] : undefined
  const remoteUsage =
    remoteRead && remoteRead.status !== 'error'
      ? headroomWindow(claudeUsageForModel(remoteRead, remoteFocused?.model))
      : null
  const pi = piUsageStores.today()
  const loadUsage =
    provider === 'pi' ? pi.load : provider === 'claude' || provider === 'codex' ? quota.load : null
  const trackerEnabled = useWorkTrackerStore((s) => s.enabled)
  const trackerMinutes = useWorkTrackerStore((s) => s.todayTotalMinutes)
  const feedbackCollapsed = useFeedbackStore((s) => s.collapsed)
  const openFeedback = useFeedbackStore((s) => s.setDialogOpen)

  useEffect(() => {
    if (provider) useUsageNavigation.getState().select(provider)
    void loadUsage?.()
  }, [loadUsage, provider])

  const openUsage = (target: UsageProvider): void => {
    useUsageNavigation.getState().select(target)
    openSettings('usage')
  }

  const showUpdateDot = dismissed && version !== null && phase === 'available'
  // The card above is showing while `collapsed === false`; the icon is the
  // collapsed form, and neither shows while the state is still null.
  const showFeedbackIcon = feedbackCollapsed === true

  // What the second line says, in order of what is worth knowing: the agent's
  // remaining headroom, else the hours worked, else nothing — and if that
  // leaves only the feedback icon, the row still carries it.
  const quotaProvider = provider === 'claude' || provider === 'codex' ? provider : null
  // The cap governing the focused tab: the account's read seen for the tab's
  // model (its family cap and the shared caps; a Codex account has one cap
  // set), the tightest of those, a tie going to the all-models cap.
  const usage =
    quotaProvider && quota.status !== 'error'
      ? headroomWindow(
          (() => {
            const read = {
              status: quota.status,
              error: null,
              ...accountUsageFieldsOf(quota.data?.windows ?? [])
            }
            return claudeUsageForModel(read, focusedSession?.model)
          })()
        )
      : null
  const piTotals = provider === 'pi' && pi.status !== 'error' ? pi.data : null
  const providerStatus = provider === 'pi' ? pi.status : quota.status
  const showProviderStatus = (quotaProvider !== null || provider === 'pi') && !usage && !piTotals
  // A Pi or OpenCode tab's stored connection is a line of its own, never part
  // of a usage line: Pi's figures are its local totals of the day on any
  // connection or none, so `Moonshot · 10.4K tokens` would read as that
  // connection's usage, and it is not (T1, PRDCT-4427).
  const harnessName = focusedSession?.piMode ? 'Pi' : 'OpenCode'
  const showWork =
    !usage && !piTotals && !showProviderStatus && trackerEnabled && trackerMinutes > 0
  const showMetaRow =
    usage !== null ||
    remoteUsage !== null ||
    piTotals !== null ||
    showProviderStatus ||
    showWork ||
    showFeedbackIcon

  return (
    <div
      className="sidebar-panel sidebar-footer"
      /* The field's own colour, handed to the CSS as the fill every control in
         this panel highlights in. It is data (one hue per palette, twelve of
         them), so it arrives as a custom property rather than as a class. */
      style={{ '--field-accent': fieldAccent(avatarField) } as React.CSSProperties}
    >
      {/* The panel's ground. Held a hair off the app's own surface and then
          grained at well over the house alpha: the gradient is genuinely there,
          you just meet the noise first — the way the website's page field sits
          under a page of reading. Fading the canvas instead would take the
          grain down with it and leave a smear. */}
      <BrandField
        palette={avatarField}
        seed={avatarSeed}
        groundLift={0.05}
        grainAlpha={0.3}
        className="sidebar-footer-field"
      />

      <div className="sidebar-footer-row sidebar-footer-row--user">
        <button
          onClick={() => openSettings()}
          className="sidebar-footer-avatar"
          title={settingsTitle}
        >
          <UserIconDisplay icon={avatarIcon} field={avatarField} seed={avatarSeed} size="xs" />
          {/* Update dot indicator when dismissed */}
          {showUpdateDot && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent border-2 border-surface-0 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation()
                undismiss()
              }}
            />
          )}
        </button>

        <button
          onClick={() => openSettings()}
          className="sidebar-footer-name"
          title={settingsTitle}
        >
          {name}
        </button>

        <button
          onClick={() => openSettings()}
          className="sidebar-footer-btn"
          title={settingsTitle}
          aria-label="Settings"
        >
          <Cog6ToothIcon className="w-4 h-4" />
        </button>
      </div>

      {connection && (
        <>
          <div className="sidebar-footer-sep" />
          <div className="sidebar-footer-row sidebar-footer-row--meta">
            {/* A control like the usage lines: a click opens Settings where
                the connection is managed (Connections). */}
            <button
              className="sidebar-footer-line"
              data-connection-line={connection.id}
              onClick={() => openSettings('accounts')}
              title={`${harnessName} · Connection: ${connection.label}`}
            >
              <span className="text-[11px] text-text-secondary truncate">
                {harnessName} · {connection.label}
              </span>
            </button>
          </div>
        </>
      )}

      {showMetaRow && (
        <>
          <div className="sidebar-footer-sep" />
          <div className="sidebar-footer-row sidebar-footer-row--meta">
            {usage && quotaProvider ? (
              <UsageLine
                window={usage}
                provider={quotaProvider}
                account={quotaProvider === 'claude' ? accountLabel : null}
              />
            ) : remoteUsage && remoteProvider && remoteOwn ? (
              <UsageLine window={remoteUsage} provider={remoteProvider} account={remoteOwn.label} />
            ) : piTotals ? (
              <button
                className="sidebar-footer-line"
                data-usage-provider="pi"
                onClick={() => openUsage('pi')}
                title={`Pi · ${piTodaySummary(piTotals)} · Local totals, not account quota`}
              >
                <PiLogo className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-[11px] text-text-secondary tabular-nums truncate">
                  {piTodaySummary(piTotals)}
                </span>
              </button>
            ) : showProviderStatus && provider ? (
              <button
                className="sidebar-footer-line"
                data-usage-provider={provider}
                onClick={() => openUsage(provider)}
                title={`${USAGE_PROVIDER_LABELS[provider]} usage`}
              >
                <span className="text-[11px] text-text-tertiary truncate">
                  {USAGE_PROVIDER_LABELS[provider]} ·{' '}
                  {providerStatus === 'idle' || providerStatus === 'loading'
                    ? 'Loading usage…'
                    : providerStatus === 'error'
                      ? 'Usage unavailable'
                      : 'No quota reported'}
                </span>
              </button>
            ) : showWork ? (
              <WorkLine />
            ) : (
              <span className="flex-1" />
            )}
            {showFeedbackIcon && (
              <button
                onClick={() => openFeedback(true)}
                className="sidebar-footer-btn"
                title="Talk to us"
                aria-label="Talk to us"
              >
                <ChatBubbleLeftRightIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
