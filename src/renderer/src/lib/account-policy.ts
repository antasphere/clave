import { useSessionStore, type Session } from '../store/session-store'
import { useClaudeAccountsUsage, useCodexAccountsUsage } from '../store/usage-store'
import { useClaudeProfileStore, getClaudeProfile } from '../store/claude-profile-store'
import { useCodexAccountStore, getCodexAccount } from '../store/codex-account-store'
import { effectiveSwitchMode, useAccountPolicyStore } from '../store/account-policy-store'
import {
  accountProviderOf,
  nextAccountFor,
  sessionAccountExhausted,
  sessionAccountId,
  switchSessionAccount
} from './switch-account'
import { decideAccountAction } from './account-policy-rule'
export { decideAccountAction, type AccountAction, type DecideInput } from './account-policy-rule'

/**
 * The policy at work (ADR 0002): watches every tab's account and, when that
 * account is about to hit its limit or the CLI has already reported it,
 * proposes the move (the default) or makes it once the agent is idle
 * (automatic). The rule is `decideAccountAction`, pure, with a test of its
 * own; `startAccountPolicy` wires it to the stores once per window.
 *
 * What it never does: interrupt a working agent. A working tab in automatic
 * mode gets the proposal shown and is moved the moment it goes idle.
 *
 * A tab whose CLI reported the limit and then ended (Claude's `-p` mode
 * ends right after its "out of credits" reply) is brought back the same
 * way, on the next account, with the rejected message sent again; a tab
 * that ended for any other reason is left as it is.
 */
function isWorking(session: Session): boolean {
  return session.agentState === 'working' || session.activityStatus === 'active'
}

function labelOf(session: Session, accountId: string): string {
  return accountProviderOf(session) === 'codex'
    ? getCodexAccount(accountId).label
    : getClaudeProfile(accountId).label
}

const switching = new Set<string>()

/** One pass over every local Claude and Codex tab. Exported for the tests. */
export function runAccountPolicy(): void {
  const store = useSessionStore.getState()
  for (const session of store.sessions) {
    const provider = accountProviderOf(session)
    if (!provider) continue
    const reported = session.limitReported === true
    const atLimit = reported || (session.alive && sessionAccountExhausted(session))
    // A proposal that no longer applies (the account recovered, the tab was
    // moved by hand) is taken down.
    if (!atLimit && session.accountProposal) {
      store.setAccountProposal(session.id, null)
      continue
    }
    const action = decideAccountAction({
      alive: session.alive,
      pinned: session.accountPinned === true,
      restarting: session.restarting === true || switching.has(session.id),
      atLimit,
      reported,
      working: session.alive && isWorking(session),
      mode: effectiveSwitchMode(session),
      nextAccountId: nextAccountFor(session),
      proposedId: session.accountProposal?.accountId ?? null,
      dismissedId: session.accountProposalDismissed ?? null
    })
    if (action.kind === 'propose') {
      store.setAccountProposal(session.id, {
        accountId: action.accountId,
        label: labelOf(session, action.accountId),
        reason: reported ? 'reported' : 'limit'
      })
    } else if (action.kind === 'switch') {
      switching.add(session.id)
      // Named while it moves, so the header and the pane can say where to.
      store.setAccountProposal(session.id, {
        accountId: action.accountId,
        label: labelOf(session, action.accountId),
        reason: reported ? 'reported' : 'limit'
      })
      void switchSessionAccount(session.id, action.accountId, {
        resendRejected: reported
      }).finally(() => {
        switching.delete(session.id)
        const current = useSessionStore.getState()
        current.setAccountProposal(session.id, null)
        current.setLimitReported(session.id, false)
      })
    }
  }
}

/** Accept a proposal: the move, by hand. */
export async function acceptAccountProposal(sessionId: string): Promise<void> {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session?.accountProposal) return
  const target = session.accountProposal.accountId
  switching.add(sessionId)
  try {
    await switchSessionAccount(sessionId, target, {
      resendRejected: session.limitReported === true
    })
  } finally {
    switching.delete(sessionId)
    const current = useSessionStore.getState()
    current.setAccountProposal(sessionId, null)
    current.setLimitReported(sessionId, false)
  }
}

/** Dismiss a proposal: not raised again for that account. */
export function dismissAccountProposal(sessionId: string): void {
  const store = useSessionStore.getState()
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session?.accountProposal) return
  store.setAccountProposalDismissed(sessionId, session.accountProposal.accountId)
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
  // not run the policy: state, life, pin, mode and the limit flag.
  let last = ''
  useSessionStore.subscribe((state) => {
    const key = state.sessions
      .map(
        (s) =>
          `${s.id}:${s.alive ? 1 : 0}${s.agentState ?? ''}${s.activityStatus}${s.accountPinned ? 'p' : ''}${s.accountSwitchMode ?? ''}${s.limitReported ? 'L' : ''}${s.claudeProfileId ?? ''}${s.codexAccountId ?? ''}${s.restarting ? 'r' : ''}`
      )
      .join('|')
    if (key === last) return
    last = key
    schedule()
  })
  window.electronAPI?.onSessionLimitReported?.((sessionId) => {
    const store = useSessionStore.getState()
    if (!store.sessions.some((s) => s.id === sessionId)) return
    store.setLimitReported(sessionId, true)
    // The poll may not have seen it yet: read the account now.
    const session = store.sessions.find((s) => s.id === sessionId)
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
