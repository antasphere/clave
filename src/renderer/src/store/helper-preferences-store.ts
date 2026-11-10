/**
 * The helpers' preference of each machine as the Settings page shows it
 * (PRDCT-4330): this Mac's and every saved server's, by machine id
 * (`LOCAL_SERVER_ID` for this Mac). Nothing here is a truth of its own: the
 * preference lives on the machine that runs the helpers, every read and
 * every write goes there (`fleetHelpers` / `fleetHelperSet`, which keep this
 * Mac's on its own route), and the list kept is that machine's last answer.
 */
import { create } from 'zustand'
import type {
  HelperAccount,
  HelperPreference,
  HelperPreferencePatch
} from '../../../shared/helper-preferences'
import { CLAUDE_MODELS, claudeModelName } from '../../../shared/claude-models'

export interface MachineHelpers {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** One safe sentence, never the raw error. */
  error: string | null
  helpers: HelperPreference[]
}

export const EMPTY_MACHINE_HELPERS: MachineHelpers = { status: 'idle', error: null, helpers: [] }

export const useHelperPreferencesStore = create<{ byMachine: Record<string, MachineHelpers> }>(
  () => ({ byMachine: {} })
)

function patchMachine(machine: string, next: (current: MachineHelpers) => MachineHelpers): void {
  useHelperPreferencesStore.setState((state) => ({
    byMachine: {
      ...state.byMachine,
      [machine]: next(state.byMachine[machine] ?? EMPTY_MACHINE_HELPERS)
    }
  }))
}

/** The refusal's own sentence when the machine gave one, else a plain one. */
function sentenceOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  // IPC wraps a refusal ("Error invoking remote method '…': Error: <sentence>").
  const sentence = message.split(/\bError: /).pop() ?? ''
  return /^(There is no helper|That is not a model|That is not an account|The switch is on or off)/.test(
    sentence
  )
    ? sentence
    : fallback
}

/** Read a machine's helpers. */
export async function loadHelperPreferences(machine: string): Promise<void> {
  patchMachine(machine, (current) => ({ ...current, status: 'loading', error: null }))
  try {
    const helpers = await window.electronAPI.fleetHelpers(machine)
    patchMachine(machine, () => ({ status: 'ready', error: null, helpers }))
  } catch {
    patchMachine(machine, (current) => ({
      ...current,
      status: 'error',
      error: 'The helpers could not be read from this machine.'
    }))
  }
}

/** Change one helper on that machine; the list on screen is its answer. */
export async function setHelperPreference(
  machine: string,
  helperId: string,
  patch: HelperPreferencePatch
): Promise<void> {
  try {
    const helpers = await window.electronAPI.fleetHelperSet(machine, helperId, patch)
    patchMachine(machine, () => ({ status: 'ready', error: null, helpers }))
  } catch (error) {
    patchMachine(machine, (current) => ({
      ...current,
      error: sentenceOf(error, 'The change did not reach the machine.')
    }))
  }
}

// ── What the page offers ─────────────────────────────────────────────────────

export interface Choice {
  value: string
  label: string
  hint?: string
}

/** The models a helper may run on: the CLI's aliases (a helper follows its
 *  family as models ship), the helper's own default first and marked; a
 *  model picked elsewhere that the list does not name stays offered. */
export function helperModelChoices(
  helper: Pick<HelperPreference, 'model' | 'defaultModel'>
): Choice[] {
  const aliases: string[] = []
  for (const model of CLAUDE_MODELS) if (!aliases.includes(model.alias)) aliases.push(model.alias)
  const ordered = [helper.defaultModel, ...aliases.filter((a) => a !== helper.defaultModel)]
  if (!ordered.includes(helper.model)) ordered.push(helper.model)
  return ordered.map((value) => ({
    value,
    label: `${claudeModelName(value) ?? value}${value === helper.defaultModel ? ' (default)' : ''}`
  }))
}

/** An account as the select carries it. */
export function accountValue(account: HelperAccount): string {
  return account.kind === 'account' ? `account:${account.accountId}` : account.kind
}

export function accountFromValue(value: string): HelperAccount {
  if (value === 'machine') return { kind: 'machine' }
  if (value.startsWith('account:')) return { kind: 'account', accountId: value.slice(8) }
  return { kind: 'session' }
}

/** The accounts a helper may run on, on that machine: the tab's own (the
 *  default), the machine login, then each Claude account the machine has
 *  but its Default (which IS the machine login). One picked earlier and
 *  since removed stays listed, said so, until another is picked. */
export function helperAccountChoices(
  accounts: ReadonlyArray<{ id: string; label: string }>,
  current: HelperAccount
): Choice[] {
  const choices: Choice[] = [
    { value: 'session', label: "The tab's own account", hint: 'The account the tab runs on' },
    { value: 'machine', label: 'Machine login', hint: 'The login of the machine itself' }
  ]
  for (const account of accounts)
    if (account.id !== 'default')
      choices.push({ value: `account:${account.id}`, label: account.label })
  if (current.kind === 'account' && !accounts.some((a) => a.id === current.accountId))
    choices.push({ value: accountValue(current), label: `${current.accountId} (removed)` })
  return choices
}

/** What a person gets when the helper is off. A helper declared later and
 *  not named here still says something true. */
const WHEN_OFF: Record<string, string> = {
  'tab-title': "Off: a tab is named after its first message's first words.",
  'exchange-digest': 'Off: exchange cards show no digest, and say the helper is off.',
  'work-digest': 'Off: work cards keep no title of their own, and say the helper is off.',
  'commit-message': 'Off: the git panel writes no commit message for you.',
  'push-summary': 'Off: the git panel writes no push summary for you.'
}

export function helperWhenOff(id: string): string {
  return WHEN_OFF[id] ?? 'Off: Clave goes without it, and nothing is asked of a model.'
}
