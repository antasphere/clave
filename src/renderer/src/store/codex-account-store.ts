import { create } from 'zustand'
import type { CodexAccount } from '../../../preload/index.d'

/**
 * A Codex account (ADR 0002): a label plus the home its sessions run on.
 *
 * The list is the main process's (`src/main/codex-accounts.ts`), mirrored
 * here like the Claude accounts. The Default is the machine's own `~/.codex`;
 * every other account is a home of its own under Clave's user data, with a
 * credential Codex's login wrote there. No credential ever reaches this
 * store: `hasCredential` is all the renderer knows.
 */
export const DEFAULT_CODEX_ACCOUNT_ID = 'default'

const DEFAULT_ACCOUNT: CodexAccount = {
  id: DEFAULT_CODEX_ACCOUNT_ID,
  label: 'Default',
  kind: 'chatgpt',
  hasCredential: false
}

interface CodexAccountState {
  accounts: CodexAccount[]
  /** The account keybinding launches use and the launcher remembers. */
  selectedAccountId: string
  loaded: boolean
  addAccount: (label: string, kind: CodexAccount['kind']) => Promise<CodexAccount | null>
  updateAccount: (id: string, updates: Partial<Pick<CodexAccount, 'label'>>) => void
  removeAccount: (id: string) => void
  reorderAccounts: (ids: string[]) => void
  setSelectedAccount: (id: string) => void
  clearCredential: (id: string) => Promise<void>
}

function persistSelected(id: string): void {
  window.electronAPI?.preferencesSet('selectedCodexAccountId', id).catch(() => {})
}

function withDefault(list: CodexAccount[]): CodexAccount[] {
  const custom = list.filter((a) => a.id !== DEFAULT_CODEX_ACCOUNT_ID)
  const fromMain = list.find((a) => a.id === DEFAULT_CODEX_ACCOUNT_ID)
  return [fromMain ?? DEFAULT_ACCOUNT, ...custom]
}

export const useCodexAccountStore = create<CodexAccountState>((set, get) => ({
  accounts: [DEFAULT_ACCOUNT],
  selectedAccountId: DEFAULT_CODEX_ACCOUNT_ID,
  loaded: false,

  addAccount: async (label, kind) => {
    const created = await window.electronAPI?.codexAccountAdd({ label, kind })
    if (!created) return null
    applyList([...get().accounts, created])
    return created
  },

  updateAccount: (id, updates) => {
    if (id === DEFAULT_CODEX_ACCOUNT_ID) return
    set((state) => ({
      accounts: state.accounts.map((a) =>
        a.id === id ? { ...a, ...(updates.label !== undefined ? { label: updates.label } : {}) } : a
      )
    }))
    void window.electronAPI?.codexAccountUpdate(id, updates)
  },

  removeAccount: (id) => {
    if (id === DEFAULT_CODEX_ACCOUNT_ID) return
    const selectedAccountId =
      get().selectedAccountId === id ? DEFAULT_CODEX_ACCOUNT_ID : get().selectedAccountId
    if (selectedAccountId !== get().selectedAccountId) persistSelected(selectedAccountId)
    set((state) => ({ accounts: state.accounts.filter((a) => a.id !== id), selectedAccountId }))
    void window.electronAPI?.codexAccountRemove(id)
  },

  reorderAccounts: (ids) => {
    set((state) => {
      const byId = new Map(state.accounts.map((a) => [a.id, a]))
      const next = [state.accounts[0]]
      for (const id of ids) {
        const a = byId.get(id)
        if (a && a.id !== DEFAULT_CODEX_ACCOUNT_ID && !next.includes(a)) next.push(a)
      }
      for (const a of state.accounts) if (!next.includes(a)) next.push(a)
      return { accounts: next }
    })
    void window.electronAPI?.codexAccountReorder(ids)
  },

  setSelectedAccount: (id) =>
    set((state) => {
      if (!state.accounts.some((a) => a.id === id)) return state
      persistSelected(id)
      return { selectedAccountId: id }
    }),

  clearCredential: async (id) => {
    await window.electronAPI.codexAccountClearCredential(id)
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === id ? { ...a, hasCredential: false } : a))
    }))
  }
}))

function applyList(list: CodexAccount[]): void {
  const accounts = withDefault(list)
  const { selectedAccountId } = useCodexAccountStore.getState()
  const keep = accounts.some((a) => a.id === selectedAccountId)
  if (!keep) persistSelected(DEFAULT_CODEX_ACCOUNT_ID)
  useCodexAccountStore.setState({
    accounts,
    selectedAccountId: keep ? selectedAccountId : DEFAULT_CODEX_ACCOUNT_ID
  })
}

/** Resolve an account by id, falling back to the Default. */
export function getCodexAccount(id: string | undefined): CodexAccount {
  const { accounts } = useCodexAccountStore.getState()
  return accounts.find((a) => a.id === id) ?? accounts[0] ?? DEFAULT_ACCOUNT
}

/** The same rule as `resolveClaudeProfile`: an id, then an exact label, then
 *  a case-insensitive one; ambiguity is nothing. */
export function resolveCodexAccount(
  accounts: CodexAccount[],
  ref: string
): CodexAccount | undefined {
  const byId = accounts.find((a) => a.id === ref)
  if (byId) return byId
  const exact = accounts.filter((a) => a.label === ref)
  if (exact.length === 1) return exact[0]
  const loose = accounts.filter((a) => a.label.toLowerCase() === ref.toLowerCase())
  return loose.length === 1 ? loose[0] : undefined
}

/** What a session says about its Codex account (see `sessionAccount`). */
export function sessionCodexAccount(session: {
  codexAccountId?: string
  codexAccountLabel?: string
}): { id: string; label: string; removed: boolean } {
  const { accounts } = useCodexAccountStore.getState()
  const live = accounts.find((a) => a.id === (session.codexAccountId ?? DEFAULT_CODEX_ACCOUNT_ID))
  if (live) return { id: live.id, label: live.label, removed: false }
  return {
    id: session.codexAccountId ?? DEFAULT_CODEX_ACCOUNT_ID,
    label: session.codexAccountLabel ?? 'Removed account',
    removed: true
  }
}

/** The spawn fields an account contributes: main resolves the home by id. */
export function codexAccountSpawnFields(account: CodexAccount): {
  codexAccountId: string
  codexAccountLabel: string
} {
  return { codexAccountId: account.id, codexAccountLabel: account.label }
}

/** The fields a clone or a resume carries from its source session. */
export function codexAccountSessionFields(session: {
  codexAccountId?: string
  codexAccountLabel?: string
}): { codexAccountId?: string; codexAccountLabel?: string } {
  if (!session.codexAccountId) return {}
  return { codexAccountId: session.codexAccountId, codexAccountLabel: session.codexAccountLabel }
}

/** How an account signs in, for a badge or a menu line. */
export function describeCodexAccountAuth(account: CodexAccount): string {
  if (account.id === DEFAULT_CODEX_ACCOUNT_ID) {
    return account.hasCredential ? 'Machine login' : 'Machine login · not signed in'
  }
  if (!account.hasCredential) return 'Not signed in'
  return account.kind === 'apiKey' ? 'API key' : 'ChatGPT'
}

/** Whether the pool may hand a session to this account at all. */
export function codexAccountUsable(account: CodexAccount): boolean {
  return account.hasCredential
}

let subscribed = false

export async function loadCodexAccounts(): Promise<void> {
  const [list, selected] = await Promise.all([
    window.electronAPI?.codexAccountsList?.().catch(() => null),
    window.electronAPI?.preferencesGet('selectedCodexAccountId') as Promise<string | null>
  ])
  const accounts = withDefault(Array.isArray(list) ? list : [])
  const selectedAccountId =
    selected && accounts.some((a) => a.id === selected) ? selected : DEFAULT_CODEX_ACCOUNT_ID
  useCodexAccountStore.setState({ accounts, selectedAccountId, loaded: true })
  if (!subscribed) {
    subscribed = true
    window.electronAPI?.onCodexAccountsChanged?.((accounts) => applyList(accounts))
  }
}
