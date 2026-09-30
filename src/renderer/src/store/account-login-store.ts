import { create } from 'zustand'
import type { AccountLoginJob } from '../../../preload/index.d'
import { claudeUsageStore, codexUsageStore } from './usage-store'

/**
 * The login flows as this window sees them (ADR 0002): one job per account,
 * pushed by main as it moves. A finished job stays until the user dismisses
 * it or starts another, so the outcome is read. Nothing here ever holds a
 * credential.
 */
export type LoginProvider = AccountLoginJob['provider']

export function loginKey(provider: LoginProvider, accountId: string): string {
  return `${provider}:${accountId}`
}

interface AccountLoginState {
  jobs: Record<string, AccountLoginJob>
  start: (provider: LoginProvider, accountId: string) => Promise<AccountLoginJob | null>
  startApiKey: (accountId: string, apiKey: string) => Promise<AccountLoginJob | null>
  sendCode: (provider: LoginProvider, accountId: string, code: string) => Promise<void>
  cancel: (provider: LoginProvider, accountId: string) => Promise<void>
  dismiss: (provider: LoginProvider, accountId: string) => void
}

function take(job: AccountLoginJob): void {
  useAccountLoginStore.setState((state) => ({
    jobs: { ...state.jobs, [loginKey(job.provider, job.accountId)]: job }
  }))
  // A login that landed a credential: read the account's usage with it,
  // which is what proves the login to the user.
  if (job.status === 'done') {
    const store =
      job.provider === 'codex' ? codexUsageStore(job.accountId) : claudeUsageStore(job.accountId)
    void store.getState().load({ force: true })
  }
}

export const useAccountLoginStore = create<AccountLoginState>((set, get) => ({
  jobs: {},

  start: async (provider, accountId) => {
    try {
      const job = await window.electronAPI.accountLoginStart(provider, accountId)
      take(job)
      return job
    } catch (err) {
      take({
        id: `local-${Date.now()}`,
        provider,
        accountId,
        status: 'failed',
        url: null,
        awaitingCode: false,
        message: err instanceof Error ? err.message : 'Could not start the login.',
        startedAt: Date.now()
      })
      return null
    }
  },

  startApiKey: async (accountId, apiKey) => {
    take({
      id: `local-${Date.now()}`,
      provider: 'codex',
      accountId,
      status: 'running',
      url: null,
      awaitingCode: false,
      message: null,
      startedAt: Date.now()
    })
    try {
      const job = await window.electronAPI.accountLoginApiKey(accountId, apiKey)
      take(job)
      return job
    } catch (err) {
      take({
        id: `local-${Date.now()}`,
        provider: 'codex',
        accountId,
        status: 'failed',
        url: null,
        awaitingCode: false,
        message: err instanceof Error ? err.message : 'Could not store the key.',
        startedAt: Date.now()
      })
      return null
    }
  },

  sendCode: async (provider, accountId, code) => {
    const job = get().jobs[loginKey(provider, accountId)]
    if (!job || job.status !== 'running') return
    await window.electronAPI.accountLoginInput(job.id, code)
  },

  cancel: async (provider, accountId) => {
    const job = get().jobs[loginKey(provider, accountId)]
    if (!job) return
    if (job.status === 'running') await window.electronAPI.accountLoginCancel(job.id)
    get().dismiss(provider, accountId)
  },

  dismiss: (provider, accountId) =>
    set((state) => {
      const jobs = { ...state.jobs }
      delete jobs[loginKey(provider, accountId)]
      return { jobs }
    })
}))

let subscribed = false

/** Follow every login any window runs, and take the ones already running. */
export async function loadAccountLogins(): Promise<void> {
  if (!subscribed) {
    subscribed = true
    window.electronAPI?.onAccountLoginProgress?.((job) => take(job))
  }
  const running = await window.electronAPI?.accountLoginList?.().catch(() => [])
  for (const job of running ?? []) take(job)
}
