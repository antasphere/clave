import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { useAccountPolicyStore } from '../store/account-policy-store'
import { useSessionStore, type Session } from '../store/session-store'
import {
  useClaudeProfileStore,
  getClaudeProfile,
  resolveClaudeProfile,
  type ClaudeProfile
} from '../store/claude-profile-store'
import {
  useCodexAccountStore,
  getCodexAccount,
  resolveCodexAccount
} from '../store/codex-account-store'
import { claudeUsageForModel, type AccountUsageSummary } from '../store/usage-store'
import {
  explicitAccountId,
  isExhausted,
  pickAccount,
  switchTargets,
  type PoolAccount
} from './account-pool'
import {
  describeAccountAuth,
  ownerAccountView,
  poolOf,
  resolveOwnedAccount,
  sessionAccountIdOf,
  sessionAccountView,
  type AccountOwnerView,
  type AccountProvider
} from './session-accounts'
import type { CodexAccount, RestartOverridesInput } from '../../../preload/index.d'
import { abandonOwnRestart, beginOwnRestart, ownAnswerApplies } from './restart-ownership'

/**
 * The pool at work (ADR 0002): which account a launch lands on, which one a
 * session moves to, and the move itself — the same tab restarted on the
 * other account with its conversation resumed.
 */
export type { AccountProvider } from './session-accounts'

/** The provider whose pool a session belongs to, or null (a terminal, Pi,
 *  Antigravity, a remote). */
export function accountProviderOf(session: Session): AccountProvider | null {
  if (session.sessionType !== 'local') return null
  if (session.claudeMode || session.claudeAgentsMode) return 'claude'
  if (session.codexMode) return 'codex'
  return null
}

/** The account a session is on, by provider. */
export function sessionAccountId(session: Session, provider: AccountProvider): string {
  return sessionAccountIdOf(session, provider)
}

/** This Mac's pool, for a launch on this Mac. */
function poolAccounts(provider: AccountProvider): PoolAccount[] {
  return poolOf(ownerAccountView(LOCAL_SERVER_ID, provider))
}

/** The pool's pick for a new session. A named account is honored; when no
 *  account is named, the selected account is used while it has headroom, else
 *  the next one along. The launch setting can opt into the menu recommendation.
 *  `model` is the model the launch will run (the `.clave` file's, the agent
 *  call's): a Claude account is judged for THAT model's caps, so a Fable
 *  week spent never costs a launch on Opus its account. With no model, the
 *  shared caps alone decide. */
export function accountForLaunch(
  provider: 'claude',
  preferredId?: string,
  model?: string
): ClaudeProfile
export function accountForLaunch(
  provider: 'codex',
  preferredId?: string,
  model?: string
): CodexAccount
export function accountForLaunch(
  provider: AccountProvider,
  preferredId?: string,
  model?: string
): ClaudeProfile | CodexAccount {
  const selected =
    provider === 'codex'
      ? useCodexAccountStore.getState().selectedAccountId
      : useClaudeProfileStore.getState().selectedProfileId
  // A named account is an instruction, not a preference. The launcher menu
  // passes the account the user clicked, so usage from another account must not
  // silently replace it. The automatic policy uses `nextAccountFor` below and
  // still rotates when the CLI reports a limit.
  if (preferredId !== undefined) {
    if (explicitAccountId(poolAccounts(provider), preferredId)) {
      return provider === 'codex' ? getCodexAccount(preferredId) : getClaudeProfile(preferredId)
    }
  }
  const id = pickAccount({
    accounts: poolAccounts(provider),
    usage: poolUsageForModel(provider, model),
    preferredId: preferredId ?? selected,
    preferRecommended:
      preferredId === undefined && useAccountPolicyStore.getState().useRecommendedAccount
  })
  return provider === 'codex' ? getCodexAccount(id) : getClaudeProfile(id)
}

/** An account named by an agent or a `.clave` file: an id, a label, or
 *  "any" for the pool's pick. Throws with the names that exist. */
export function resolveAccountRef(
  provider: AccountProvider,
  ref: string | undefined,
  model?: string
): ClaudeProfile | CodexAccount {
  if (!ref || ref === 'any') {
    return provider === 'codex'
      ? accountForLaunch('codex', undefined, model)
      : accountForLaunch('claude', undefined, model)
  }
  if (provider === 'codex') {
    const { accounts } = useCodexAccountStore.getState()
    const account = resolveCodexAccount(accounts, ref)
    if (account) return account
    const names = accounts.map((a) => `"${a.label}" (${a.id})`).join(', ')
    throw new Error(`Unknown Codex account "${ref}". Available: ${names}`)
  }
  const { profiles } = useClaudeProfileStore.getState()
  const account = resolveClaudeProfile(profiles, ref)
  if (account) return account
  const names = profiles.map((p) => `"${p.label}" (${p.id})`).join(', ')
  throw new Error(`Unknown Claude account "${ref}". Available: ${names}`)
}

/** An account an agent names for a session's move: an id, a label, or "any"
 *  for the pool's next account, all in the tab's OWNER's list (a server tab
 *  moves among that server's accounts). Throws with the names that exist. */
export function resolveSessionAccountRef(
  session: Session,
  provider: AccountProvider,
  ref: string
): { id: string; label: string } {
  const view = sessionAccountView(session, provider)
  if (!view.known) throw new Error("The server's accounts are not read yet; try again in a moment")
  if (ref === 'any') {
    const next = nextAccountFor(session)
    if (!next) throw new Error('No other account of this provider has headroom')
    const account = view.accounts.find((a) => a.id === next)
    if (account) return account
  }
  const account = resolveOwnedAccount(view, ref)
  if (account) return account
  const names = view.accounts.map((a) => `"${a.label}" (${a.id})`).join(', ')
  const kind = provider === 'codex' ? 'Codex' : 'Claude'
  throw new Error(`Unknown ${kind} account "${ref}". Available: ${names}`)
}

/** Whether the account a session runs on is about to stop it. */
export function sessionAccountExhausted(session: Session): boolean {
  const provider = accountProviderOf(session)
  if (!provider) return false
  return isExhausted(sessionAccountUsage(session))
}

/** The summary of the account a session runs on, for a badge. */
export function sessionAccountUsage(session: Session): AccountUsageSummary | undefined {
  const provider = accountProviderOf(session)
  if (!provider) return undefined
  // The owner's usage: a server tab's id is an id of that server's list.
  const summary = sessionAccountView(session, provider).usage[sessionAccountId(session, provider)]
  return claudeUsageForModel(summary, session.model)
}

/** Every account's usage as seen for one model: the shared caps plus that
 *  model's family cap on each (Claude's families, Codex's model buckets). */
function viewUsageForModel(
  view: AccountOwnerView,
  model: string | undefined
): Record<string, AccountUsageSummary | undefined> {
  return Object.fromEntries(
    Object.entries(view.usage).map(([id, summary]) => [id, claudeUsageForModel(summary, model)])
  )
}

function poolUsageForModel(
  provider: AccountProvider,
  model: string | undefined
): Record<string, AccountUsageSummary | undefined> {
  return viewUsageForModel(ownerAccountView(LOCAL_SERVER_ID, provider), model)
}

/** One account a session could move to, as the Switch account menu draws it. */
export interface SwitchTarget {
  id: string
  provider: AccountProvider
  model?: string
  label: string
  /** How the account signs in ("Max 20x", "API key"), for the preview. */
  auth: string
  exhausted: boolean
  /** The open account the pool would spend first: its week renews soonest. */
  suggested: boolean
  /** The soonest weekly reset among its caps, or null when none says. */
  weeklyResetAt: number | null
  summary: AccountUsageSummary | undefined
}

/** The accounts a session could move to, in the menu's order: those with
 *  headroom first, each side by its soonest weekly reset. */
export function sessionSwitchTargets(session: Session): SwitchTarget[] {
  const provider = accountProviderOf(session)
  if (!provider) return []
  // The tab's OWNER's accounts: a server tab moves among that server's.
  const view = sessionAccountView(session, provider)
  if (!view.known) return []
  const current = sessionAccountId(session, provider)
  const usage = viewUsageForModel(view, session.model)
  return switchTargets(poolOf(view), usage, current).flatMap((t) => {
    const account = view.accounts.find((a) => a.id === t.id)
    if (!account) return []
    return [
      {
        ...t,
        provider,
        model: session.model,
        label: account.label,
        auth: describeAccountAuth(provider, account),
        summary: usage[t.id]
      }
    ]
  })
}

/** The pool's next account for a session leaving the one it is on. Null
 *  when nowhere else has headroom. */
export function nextAccountFor(session: Session): string | null {
  const provider = accountProviderOf(session)
  if (!provider) return null
  const current = sessionAccountId(session, provider)
  const view = sessionAccountView(session, provider)
  if (!view.known) return null
  const next = pickAccount({
    accounts: poolOf(view),
    usage: viewUsageForModel(view, session.model),
    preferredId: current,
    leavingId: current,
    preferWeeklyHeadroom: true
  })
  return next === current ? null : next
}

export interface SwitchResult {
  ok: boolean
  /** The conversation came along; false means the tab started fresh. */
  resumed: boolean
  error?: string
}

/** The part of a restart's patch the served `session.restarted` push does
 *  not carry: the provider switch's fields (PRDCT-4300). Null when the patch
 *  holds none. */
function providerPatchOf(
  patch: Record<string, unknown> | undefined
): Partial<
  Pick<
    Session,
    'claudeMode' | 'codexMode' | 'claudeAgentsMode' | 'launchProfileId' | 'model' | 'continuedFrom'
  >
> | null {
  if (!patch) return null
  const keys = [
    'claudeMode',
    'codexMode',
    'claudeAgentsMode',
    'launchProfileId',
    'model',
    'continuedFrom'
  ] as const
  const rest: Record<string, unknown> = {}
  for (const key of keys) if (key in patch) rest[key] = patch[key]
  return Object.keys(rest).length ? (rest as ReturnType<typeof providerPatchOf>) : null
}

/**
 * Move a session to another account: main stops its process, spawns the
 * same thing again under the same id on the new account with the
 * conversation resumed, and the store remounts the pane on the answer.
 * `resendRejected` sends the message the old account's limit rejected again
 * on the new one — the move the limit itself caused, never a move by hand.
 */
export async function switchSessionAccount(
  sessionId: string,
  accountId: string,
  options: { resendRejected?: boolean } = {}
): Promise<SwitchResult> {
  const store = useSessionStore.getState()
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, resumed: false, error: 'No such session' }
  const provider = accountProviderOf(session)
  if (!provider) return { ok: false, resumed: false, error: 'This tab has no account to switch' }
  if (sessionAccountId(session, provider) === accountId) return { ok: true, resumed: true }
  // Named in the tab's OWNER's list: a server tab restarts on the server, on
  // an account of that server, never on one of this Mac's.
  const account = sessionAccountView(session, provider).accounts.find((a) => a.id === accountId)
  if (!account) return { ok: false, resumed: false, error: `Unknown account "${accountId}"` }
  const overrides =
    provider === 'codex'
      ? { codexAccountId: account.id, codexAccountLabel: account.label }
      : { claudeProfileId: account.id, claudeProfileLabel: account.label }
  return restartSessionProcess(sessionId, {
    overrides,
    resendRejected: options.resendRejected === true,
    patch: provider === 'codex' ? overrides : { ...overrides, claudeConfigDir: undefined }
  })
}

/**
 * Stop a session's process and spawn the same thing again under the same id,
 * the conversation resumed where the agent can resume it (Claude, Codex): the
 * account switch, and the restart onto a newly upgraded agent CLI. `patch`
 * is what the store learns besides the answer's own fields.
 */
export async function restartSessionProcess(
  sessionId: string,
  options: {
    overrides?: RestartOverridesInput
    resendRejected?: boolean
    /** A Resume, not a move: the host refuses it while the session runs. */
    onlyIfStopped?: boolean
    patch?: Partial<
      Pick<
        Session,
        | 'claudeProfileId'
        | 'claudeProfileLabel'
        | 'claudeConfigDir'
        | 'codexAccountId'
        | 'codexAccountLabel'
        // A move to another provider (PRDCT-4300, `switch-provider.ts`).
        | 'claudeMode'
        | 'codexMode'
        | 'claudeAgentsMode'
        | 'launchProfileId'
        | 'model'
        | 'continuedFrom'
      >
    >
  } = {}
): Promise<SwitchResult> {
  const store = useSessionStore.getState()
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, resumed: false, error: 'No such session' }
  store.setSessionRestarting(sessionId, true)
  // Marked before the call: the server's `session.restarted` push for this
  // very move can reach the window before the answer does, and only one of
  // the two may remount the pane (`restart-ownership.ts`).
  const requestId = crypto.randomUUID()
  beginOwnRestart(sessionId, requestId)
  const result = await window.electronAPI
    .restartSession(
      sessionId,
      {
        ...options.overrides,
        resendRejected: options.resendRejected === true,
        ...(options.onlyIfStopped ? { onlyIfStopped: true } : {})
      },
      requestId
    )
    .catch((err) => ({
      error: err instanceof Error ? err.message : String(err)
    }))
  if ('error' in result) {
    abandonOwnRestart(requestId)
    useSessionStore.getState().setSessionRestarting(sessionId, false)
    return { ok: false, resumed: false, error: result.error }
  }
  // The push applied it already: the answer only reports. The push knows
  // the account alone; what a provider switch changes besides (the family,
  // the model, the card's note) is written here without remounting again.
  if (!ownAnswerApplies(sessionId, requestId, result.requestId)) {
    if (providerPatchOf(options.patch)) {
      // The whole of what the answer-first road writes, the conversation id
      // the answer names included (the push left the old provider's), the
      // epoch untouched since the pane remounted on the push already.
      const rest = {
        claudeSessionId: result.claudeSessionId,
        launchProfileId: result.launchProfileId,
        model: result.model,
        ...options.patch
      }
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...rest } : s))
      }))
    }
    return { ok: true, resumed: result.resumed }
  }
  const current = useSessionStore.getState()
  current.applySessionRestart(sessionId, {
    claudeSessionId: result.claudeSessionId,
    launchProfileId: result.launchProfileId,
    model: result.model,
    ...options.patch
  })
  // The new process starts when its pane measures itself, which a pane that
  // is not on screen never does (a background tab moved by the policy would
  // sit pending until viewed). Kick it at a plain size, the way a restored
  // hidden session is kicked; a pane on screen refits it at once.
  const onScreen =
    current.activeView === 'terminals' && current.selectedSessionIds.includes(sessionId)
  if (!onScreen && session.sessionType === 'local') {
    window.electronAPI.startSession(sessionId, 120, 30)
  }
  return { ok: true, resumed: result.resumed }
}
