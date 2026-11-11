/**
 * The helpers' preference of each machine as the Settings page shows it
 * (PRDCT-4330): this Mac's and every saved server's, by machine id
 * (`LOCAL_SERVER_ID` for this Mac). Nothing here is a truth of its own: the
 * preference lives on the machine that runs the helpers, every read and
 * every write goes there (`fleetHelpers` / `fleetHelperSet`, which keep this
 * Mac's on its own route), and the list kept is that machine's last answer.
 */
import { create } from 'zustand'
import {
  HELPERS_NEED_UPDATE,
  type HelperAccount,
  type HelperPreference,
  type HelperPreferencePatch
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
  } catch (error) {
    // A server released before this page answers its routes with a 404,
    // which the client says as the update it needs.
    const message = error instanceof Error ? error.message : ''
    patchMachine(machine, (current) => ({
      ...current,
      status: 'error',
      error: message.includes(HELPERS_NEED_UPDATE)
        ? HELPERS_NEED_UPDATE
        : 'The helpers could not be read from this machine.'
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

/** The models a helper may run on: the CLI's aliases, labelled by family
 *  ("Haiku"), never by a version: the helper passes the alias and the CLI
 *  decides which model it is. The helper's own default comes first and is
 *  marked; a model picked elsewhere that the list does not name stays
 *  offered, read from its id. */
export function helperModelChoices(
  helper: Pick<HelperPreference, 'model' | 'defaultModel'>
): Choice[] {
  const aliases: string[] = []
  for (const model of CLAUDE_MODELS) if (!aliases.includes(model.alias)) aliases.push(model.alias)
  const ordered = [helper.defaultModel, ...aliases.filter((a) => a !== helper.defaultModel)]
  if (!ordered.includes(helper.model)) ordered.push(helper.model)
  return ordered.map((value) => ({
    value,
    label: `${aliasLabel(value)}${value === helper.defaultModel ? ' (default)' : ''}`
  }))
}

function aliasLabel(value: string): string {
  if (CLAUDE_MODELS.some((model) => model.alias === value))
    return value.charAt(0).toUpperCase() + value.slice(1)
  return claudeModelName(value) ?? value
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
 *  but its Default (which IS the machine login). An account removed since
 *  it was picked is not offered: the machine reports the helper on the
 *  tab's own (`accountRemoved`), and the row says so. */
export function helperAccountChoices(
  accounts: ReadonlyArray<{ id: string; label: string }>
): Choice[] {
  const choices: Choice[] = [
    { value: 'session', label: "The tab's own account", hint: 'The account the tab runs on' },
    { value: 'machine', label: 'Machine login', hint: 'The login of the machine itself' }
  ]
  for (const account of accounts)
    if (account.id !== 'default')
      choices.push({ value: `account:${account.id}`, label: account.label })
  return choices
}

/** What a person gets when the helper is off. A helper declared later and
 *  not named here still says something true. */
const WHEN_OFF: Record<string, string> = {
  'tab-title': "Off: a tab is named after its first message's first words.",
  // The cards' own words (`plugins/chat-view/src/digest.ts`, digestFailureLine).
  'exchange-digest':
    'Off: an exchange card shows no digest and reads "Not read: digests are switched off in Settings."',
  'work-digest':
    'Off: a work card keeps no title of its own and reads "No title: titles are switched off in Settings."',
  'commit-message': 'Off: the git panel writes no commit message for you.',
  'push-summary': 'Off: the git panel writes no push summary for you.',
  // The permission card's own words (`plugins/chat-view/src/PermissionReading.tsx`):
  // the rules' level alone, "Not verified" where they cannot tell.
  'permission-explainer':
    'Off: a permission card shows only the level the rules found, or "Not verified", and reads "Could not read what this does".',
  'spoken-rendering': 'Off: Folio reads the answer as written, markdown stripped.',
  'page-title': 'Off: a page is titled by the first sentence of the message.'
}

/** What the helper does, in plain words, for the line under its name. */
const WHAT_IT_DOES: Record<string, string> = {
  'tab-title': 'Names a new tab from its first message.',
  'exchange-digest': 'Sums up each exchange of a chat on its card.',
  'work-digest': 'Titles each stretch of an agent’s work on its card.',
  'commit-message': 'Writes the commit message in the git panel.',
  'push-summary': 'Writes the summary of what a push sends.',
  'permission-explainer': 'Says in plain words, on a permission card, what allowing it would do.',
  'spoken-rendering': 'Rewrites an answer for the ear before Folio reads it aloud.',
  'page-title': 'Titles each Folio page from the question it holds.'
}

export function helperDoes(id: string): string {
  return WHAT_IT_DOES[id] ?? 'A short call Clave makes on its own.'
}

/** The row's line for a helper on an account that is gone. */
export const ACCOUNT_REMOVED = "Its account was removed: it runs on the tab's own account."

export function helperWhenOff(id: string): string {
  return WHEN_OFF[id] ?? 'Off: Clave goes without it, and nothing is asked of a model.'
}
