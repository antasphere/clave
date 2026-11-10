import { isRemoteKey } from './fleet-identity'
import { useSessionStore, type Session } from '../store/session-store'
import type { LimitRung } from '../store/session-types'
import {
  accountsUsageFor,
  useClaudeAccountsUsage,
  useCodexAccountsUsage
} from '../store/usage-store'
import { useClaudeProfileStore, getClaudeProfile } from '../store/claude-profile-store'
import { useCodexAccountStore, getCodexAccount } from '../store/codex-account-store'
import {
  effectiveFamilyLimitRule,
  effectiveSwitchMode,
  useAccountPolicyStore
} from '../store/account-policy-store'
import {
  accountProviderOf,
  nextAccountFor,
  sessionAccountExhausted,
  sessionAccountId,
  sessionAccountUsage,
  switchSessionAccount
} from './switch-account'
import { claudeModelName } from '../../../shared/claude-models'
import { isChatProfileRef } from '../../../shared/open-session-modes'
import { scopeFamily } from '../../../shared/limit-report'
import { decideAccountAction, ladderKey, type Rung } from './account-policy-rule'
import { modelRungFor, resolveLimitScope } from './limit-scope'
import { PendingModelSwitches } from './model-switch-pending'
export {
  decideAccountAction,
  ladderKey,
  rungKey,
  type AccountAction,
  type DecideInput,
  type Rung
} from './account-policy-rule'

/**
 * The policy at work (ADR 0002, amended by PRDCT-4302): watches every tab's
 * account and, when that account is about to hit its limit or the CLI has
 * already reported it, proposes the way on (the default) or takes it once
 * the agent is idle (automatic). The rule is `decideAccountAction`, pure,
 * with a test of its own; `startAccountPolicy` wires it to the stores once
 * per window.
 *
 * Three rungs. A FAMILY's cap (the Fable week spent while the account's
 * shared caps are open) offers the newest model of the next family down on
 * the same account, set on the live session with no restart; the CLI's own
 * words at that moment are "Switch to another model". A SHARED cap or the
 * org's CREDITS offer another account: the tab is restarted there with its
 * conversation resumed. A PROVIDER (continue on Codex) is offered third,
 * only when another module registered that road (`registerProviderSwitchRoad`),
 * and never taken on its own.
 *
 * What it never does: interrupt a working agent. A working tab in automatic
 * mode gets the proposal shown and is moved the moment it goes idle.
 *
 * A tab whose CLI reported the limit and then ended (Claude's `-p` mode
 * ends right after its "out of credits" reply) is brought back the same
 * way, on the next account, with the rejected message sent again; a tab
 * that ended for any other reason is left as it is.
 */
/** A tab whose session runs a chat adapter, the one kind that takes a
 *  `set_model` on the live process (`isChatProfileRef`). */
export function isChatSession(session: Session, provider: 'claude' | 'codex'): boolean {
  return !!session.launchProfileId && isChatProfileRef(provider, session.launchProfileId)
}

function isWorking(session: Session): boolean {
  return session.agentState === 'working' || session.activityStatus === 'active'
}

function accountLabelOf(session: Session, accountId: string): string {
  return accountProviderOf(session) === 'codex'
    ? getCodexAccount(accountId).label
    : getClaudeProfile(accountId).label
}

/** The road to another provider (lane D's `switch-provider.ts`): which
 *  adapter a session could continue on, and the move itself. Absent, the
 *  policy offers two rungs. */
export interface ProviderSwitchRoad {
  targetFor(session: Session): { adapterId: string; label: string } | null
  /** The move; `resendRejected` when the CLI's limit rejected a message:
   *  the road carries it once as the new provider's first turn after the
   *  converted history (integration round 2, G7), and this side closes the
   *  report on the move and never resends it on the old tab. */
  switchTo(
    sessionId: string,
    adapterId: string,
    options: { resendRejected: boolean }
  ): Promise<unknown>
}

/** The road's word that the person cancelled in its popover: nothing moved. */
function wasCancelled(result: unknown): boolean {
  return (
    !!result && typeof result === 'object' && (result as { cancelled?: unknown }).cancelled === true
  )
}

let providerRoad: ProviderSwitchRoad | null = null

/** Register (or, with null, withdraw) the provider rung's road. */
export function registerProviderSwitchRoad(road: ProviderSwitchRoad | null): void {
  providerRoad = road
}

const switching = new Set<string>()
/** The model switches written and not yet confirmed by the provider. */
const pendingModels = new PendingModelSwitches()
/** The model each open report arrived on: a model change since, by the
 *  policy's rung or the person from the chip, is the way on taken, and
 *  closes the report in the window as main closes its own (integration
 *  round 1, F3). */
const reportedOn = new Map<string, string | undefined>()

function labelled(session: Session, rungs: Rung[]): LimitRung[] {
  return rungs.map((rung) => {
    switch (rung.kind) {
      case 'model':
        return { ...rung, label: claudeModelName(rung.model) ?? rung.model }
      case 'account':
        return { ...rung, label: accountLabelOf(session, rung.accountId) }
      case 'provider':
        return {
          ...rung,
          label: providerRoad?.targetFor(session)?.label ?? rung.adapterId
        }
    }
  })
}

/** Clear what a move answered: the proposal, and the CLI's report unless
 *  the move is a model switch the provider has not confirmed yet. The
 *  report then closes when the model change lands (`closedByModelChange`),
 *  and stays open if the CLI refuses the switch, so the account rung that
 *  follows still resends the rejected message (integration round 1, F4). */
function settled(sessionId: string, options: { keepReport?: boolean } = {}): void {
  switching.delete(sessionId)
  const current = useSessionStore.getState()
  current.setAccountProposal(sessionId, null)
  if (!options.keepReport) {
    current.setLimitReported(sessionId, null)
    reportedOn.delete(sessionId)
    pendingModels.forget(sessionId)
  }
}

/** The tab runs another model than the one its open report arrived on: the
 *  way on was taken, by the policy or by hand, and main has resent the
 *  rejected message on it. The report and whatever it proposed are closed. */
function closedByModelChange(session: Session): boolean {
  if (!reportedOn.has(session.id)) return false
  const on = reportedOn.get(session.id)
  return on !== undefined && session.model !== undefined && session.model !== on
}

/** The model rung: `set_model` on the live session, no restart. The CLI's
 *  confirmation reaches the sidebar through the model push (PRDCT-4256) and
 *  the message the cap rejected goes again on the new model from main, while
 *  the report is open there (`pty-manager.ts`). */
async function switchSessionModel(sessionId: string, model: string): Promise<void> {
  pendingModels.begin(sessionId, model)
  try {
    // Not remembered as the next chat's default: the way on at a cap is this
    // tab's, not the person's pick (round 1, F3).
    await window.electronAPI.sessionsWrite(sessionId, { type: 'set_model', model, remember: false })
  } catch (error) {
    pendingModels.forget(sessionId)
    throw error
  }
}

/** One pass over every local Claude and Codex tab. Exported for the tests. */
export function runAccountPolicy(): void {
  const store = useSessionStore.getState()
  for (const session of store.sessions) {
    if (isRemoteKey(session.id)) continue
    const provider = accountProviderOf(session)
    if (!provider) continue
    const report = session.limitReported ?? null
    if (report && closedByModelChange(session)) {
      store.setLimitReported(session.id, null)
      store.setAccountProposal(session.id, null)
      reportedOn.delete(session.id)
      pendingModels.forget(session.id)
      continue
    }
    const reported = report !== null
    const view = sessionAccountUsage(session)
    const atLimit = reported || (session.alive && sessionAccountExhausted(session))
    // A proposal that no longer applies (the account recovered, the tab was
    // moved by hand) is taken down.
    if (!atLimit && session.accountProposal) {
      store.setAccountProposal(session.id, null)
      continue
    }
    if (!atLimit) continue
    const scope = resolveLimitScope(report, view)
    const family = scopeFamily(scope)
    // Settled first: a window that closed without the model records the
    // refusal the rung below must not repeat.
    const switchInFlight = pendingModels.inFlight(session.id, session.model)
    // The model rung reads the ACCOUNT's view: every family's cap, not the
    // session's own alone. Only a chat can take `set_model`: a terminal CLI's
    // model is its own, so a terminal tab is offered the account rung.
    // The rung comes from the Claude model table: a Codex tab has no model
    // rung yet (integration round 1, F6 and G4). A model the CLI refused
    // while this report was open is not offered again.
    const accountView = accountsUsageFor(provider)[sessionAccountId(session, provider)]
    const candidate =
      family && provider === 'claude' && isChatSession(session, provider)
        ? modelRungFor(family, accountView)
        : null
    const nextModel =
      candidate && pendingModels.refusedModel(session.id) === candidate ? null : candidate
    const action = decideAccountAction({
      alive: session.alive,
      accountPinned: session.accountPinned === true,
      modelPinned: session.modelPinned === true,
      // A move in flight, an account's restart or a model switch the
      // provider has not confirmed yet, holds the policy off the tab.
      restarting: session.restarting === true || switching.has(session.id) || switchInFlight,
      atLimit,
      reported,
      working: session.alive && isWorking(session),
      mode: effectiveSwitchMode(session),
      onFamilyLimit: effectiveFamilyLimitRule(session),
      scope,
      nextModel,
      nextAccountId: nextAccountFor(session),
      nextAdapterId: providerRoad?.targetFor(session)?.adapterId ?? null,
      proposedKey: session.accountProposal ? ladderKey(session.accountProposal.rungs) : null,
      dismissedKey: session.accountProposalDismissed ?? null
    })
    const reason = reported ? 'reported' : 'limit'
    if (action.kind === 'propose') {
      store.setAccountProposal(session.id, { reason, rungs: labelled(session, action.rungs) })
    } else if (action.kind === 'switch-account') {
      switching.add(session.id)
      // Named while it moves, so the header and the pane can say where to.
      store.setAccountProposal(session.id, {
        reason,
        rungs: labelled(session, [{ kind: 'account', accountId: action.accountId }])
      })
      void switchSessionAccount(session.id, action.accountId, {
        resendRejected: reported
      }).finally(() => settled(session.id))
    } else if (action.kind === 'switch-model') {
      switching.add(session.id)
      store.setAccountProposal(session.id, {
        reason,
        rungs: labelled(session, [{ kind: 'model', model: action.model }])
      })
      void switchSessionModel(session.id, action.model)
        .catch((error) => console.error('Model switch at limit failed:', error))
        .finally(() => settled(session.id, { keepReport: true }))
    }
  }
}

/** Take one rung of the proposal, by hand. While it moves, the proposal is
 *  the rung taken alone, so the pane's notice names where the tab goes
 *  (`Moving to Codex…`, integration round 2, F12). A provider road the
 *  person cancels in its popover moved nothing: the ladder and the report
 *  stand again as they were (lane D's round-2 note). */
export async function acceptRung(sessionId: string, rung: LimitRung): Promise<void> {
  const store = useSessionStore.getState()
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session?.accountProposal) return
  const ladder = session.accountProposal
  switching.add(sessionId)
  store.setAccountProposal(sessionId, { reason: ladder.reason, rungs: [rung] })
  const resendRejected = !!session.limitReported
  let cancelled = false
  try {
    if (rung.kind === 'account') {
      await switchSessionAccount(sessionId, rung.accountId, { resendRejected })
    } else if (rung.kind === 'model') {
      await switchSessionModel(sessionId, rung.model)
    } else if (providerRoad) {
      cancelled = wasCancelled(
        await providerRoad.switchTo(sessionId, rung.adapterId, { resendRejected })
      )
    }
  } finally {
    if (cancelled) {
      switching.delete(sessionId)
      useSessionStore.getState().setAccountProposal(sessionId, ladder)
    } else {
      settled(sessionId, { keepReport: rung.kind === 'model' })
    }
  }
}

/** Accept the account rung of a proposal: the move, by hand. */
export async function acceptAccountProposal(sessionId: string): Promise<void> {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
  const rung = session?.accountProposal?.rungs.find((r) => r.kind === 'account')
  if (rung) await acceptRung(sessionId, rung)
}

/** Dismiss a proposal: that ladder is not raised again until it changes. */
export function dismissAccountProposal(sessionId: string): void {
  const store = useSessionStore.getState()
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session?.accountProposal) return
  store.setAccountProposalDismissed(sessionId, ladderKey(session.accountProposal.rungs))
  store.setAccountProposal(sessionId, null)
}

let started = false

/** Wire the policy to what moves it: the usage mirrors, the sessions' own
 *  state, the account lists, the mode, and the CLI's own reports. */
export function startAccountPolicy(): void {
  if (started) return
  started = true
  let scheduled = false
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      runAccountPolicy()
    })
  }
  useClaudeAccountsUsage.subscribe(schedule)
  useCodexAccountsUsage.subscribe(schedule)
  useClaudeProfileStore.subscribe(schedule)
  useCodexAccountStore.subscribe(schedule)
  useAccountPolicyStore.subscribe(schedule)
  // Only the fields the decision reads, so a byte of terminal output does
  // not run the policy: state, life, pins, mode, model and the limit report.
  let last = ''
  useSessionStore.subscribe((state) => {
    const key = state.sessions
      .map(
        (s) =>
          `${s.id}:${s.alive ? 1 : 0}${s.agentState ?? ''}${s.activityStatus}${s.accountPinned ? 'p' : ''}${s.modelPinned ? 'm' : ''}${s.accountSwitchMode ?? ''}${s.limitReported ? 'L' : ''}${s.model ?? ''}${s.claudeProfileId ?? ''}${s.codexAccountId ?? ''}${s.restarting ? 'r' : ''}`
      )
      .join('|')
    if (key === last) return
    last = key
    schedule()
  })
  window.electronAPI?.onSessionLimitReported?.(({ id, report }) => {
    const store = useSessionStore.getState()
    const session = store.sessions.find((s) => s.id === id)
    if (!session) return
    store.setLimitReported(id, report)
    reportedOn.set(id, session.model)
    // The poll may not have seen it yet: read the account now. The read is
    // what settles a report the CLI typed as a plain week (`limit-scope.ts`).
    const provider = accountProviderOf(session)
    if (provider) {
      const accountId = sessionAccountId(session, provider)
      if (provider === 'codex') {
        void window.electronAPI.getCodexUsageLimits(accountId, { force: true })
      } else {
        void window.electronAPI.getUsageLimits(accountId, { force: true })
      }
    }
    schedule()
  })
}
