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
  switchTo(sessionId: string, adapterId: string): Promise<unknown>
}

let providerRoad: ProviderSwitchRoad | null = null

/** Register (or, with null, withdraw) the provider rung's road. */
export function registerProviderSwitchRoad(road: ProviderSwitchRoad | null): void {
  providerRoad = road
}

const switching = new Set<string>()
/** The model switches written and not yet confirmed by the provider. */
const pendingModels = new PendingModelSwitches()

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

/** Clear what a move answered: the proposal and the CLI's report. */
function settled(sessionId: string): void {
  switching.delete(sessionId)
  const current = useSessionStore.getState()
  current.setAccountProposal(sessionId, null)
  current.setLimitReported(sessionId, null)
}

/** The model rung: `set_model` on the live session, no restart. The CLI's
 *  confirmation reaches the sidebar through the model push (PRDCT-4256) and
 *  the message the cap rejected goes again on the new model from main, while
 *  the report is open there (`pty-manager.ts`). */
async function switchSessionModel(sessionId: string, model: string): Promise<void> {
  pendingModels.begin(sessionId, model)
  try {
    await window.electronAPI.sessionsWrite(sessionId, { type: 'set_model', model })
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
    // The model rung reads the ACCOUNT's view: every family's cap, not the
    // session's own alone. Only a chat can take `set_model`: a terminal CLI's
    // model is its own, so a terminal tab is offered the account rung.
    const accountView = accountsUsageFor(provider)[sessionAccountId(session, provider)]
    const nextModel =
      family && isChatSession(session, provider) ? modelRungFor(family, accountView) : null
    const action = decideAccountAction({
      alive: session.alive,
      accountPinned: session.accountPinned === true,
      modelPinned: session.modelPinned === true,
      // A move in flight, an account's restart or a model switch the
      // provider has not confirmed yet, holds the policy off the tab.
      restarting:
        session.restarting === true ||
        switching.has(session.id) ||
        pendingModels.inFlight(session.id, session.model),
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
        .finally(() => settled(session.id))
    }
  }
}

/** Take one rung of the proposal, by hand. */
export async function acceptRung(sessionId: string, rung: LimitRung): Promise<void> {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session?.accountProposal) return
  switching.add(sessionId)
  try {
    if (rung.kind === 'account') {
      await switchSessionAccount(sessionId, rung.accountId, {
        resendRejected: !!session.limitReported
      })
    } else if (rung.kind === 'model') {
      await switchSessionModel(sessionId, rung.model)
    } else if (providerRoad) {
      await providerRoad.switchTo(sessionId, rung.adapterId)
    }
  } finally {
    settled(sessionId)
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
    if (!store.sessions.some((s) => s.id === id)) return
    store.setLimitReported(id, report)
    // The poll may not have seen it yet: read the account now. The read is
    // what settles a report the CLI typed as a plain week (`limit-scope.ts`).
    const session = store.sessions.find((s) => s.id === id)
    const provider = session ? accountProviderOf(session) : null
    if (session && provider) {
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
