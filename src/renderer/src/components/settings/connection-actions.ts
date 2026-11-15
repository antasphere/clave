/**
 * What the cards of Settings → Connections do beyond drawing (PRDCT-4552),
 * kept out of the component files so they export components alone.
 */
import { useEffect } from 'react'
import type { CodexAccount } from '../../../../preload/index.d'
import { useAccountLoginStore } from '../../store/account-login-store'
import { DEFAULT_CODEX_ACCOUNT_ID } from '../../store/codex-account-store'
import {
  startProviderConnectionsEvents,
  useProviderConnectionsStore,
  EMPTY_MACHINE_PROVIDER_CONNECTIONS,
  type MachineProviderConnections
} from '../../store/provider-connections-store'

/** Bring an element into view once it is drawn (a card a sign-in opened, a
 *  form that unfolded). */
export function reveal(selector: string): void {
  requestAnimationFrame(() =>
    document.querySelector(selector)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  )
}

/** Store a Codex connection's API key; null when it took, else the sentence. */
export async function submitCodexKey(accountId: string, apiKey: string): Promise<string | null> {
  const job = await useAccountLoginStore.getState().startApiKey(accountId, apiKey)
  return job?.status === 'done' ? null : (job?.message ?? 'Could not store the key.')
}

/** Whether a Codex account belongs among what is connected: every one Clave
 *  was handed, and the machine's own `~/.codex` once it is signed in (until
 *  then, the OpenAI card is how it is signed in). */
export function codexAccountShown(account: Pick<CodexAccount, 'id' | 'hasCredential'>): boolean {
  return account.id !== DEFAULT_CODEX_ACCOUNT_ID || account.hasCredential
}

/** One machine's provider connections as the store holds them. */
export function useProviderConnectionsOf(machine: string): MachineProviderConnections {
  return useProviderConnectionsStore(
    (s) => s.byMachine[machine] ?? EMPTY_MACHINE_PROVIDER_CONNECTIONS
  )
}

/** The same, loaded when the page shows that machine and kept current by
 *  its pushes: called once, by the page. */
export function useProviderMachine(machine: string): MachineProviderConnections {
  const state = useProviderConnectionsOf(machine)
  const load = useProviderConnectionsStore((s) => s.load)
  useEffect(() => {
    startProviderConnectionsEvents()
  }, [])
  useEffect(() => {
    void load(machine)
  }, [machine, load])
  return state
}
