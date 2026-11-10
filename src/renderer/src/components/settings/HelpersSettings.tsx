import { useEffect, type ReactElement, type ReactNode } from 'react'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { HELPERS_NEED_UPDATE, type HelperPreference } from '../../../../shared/helper-preferences'
import { useClaudeProfileStore } from '../../store/claude-profile-store'
import {
  ACCOUNT_REMOVED,
  EMPTY_MACHINE_HELPERS,
  helperDoes,
  accountFromValue,
  accountValue,
  helperAccountChoices,
  helperModelChoices,
  helperWhenOff,
  loadHelperPreferences,
  setHelperPreference,
  useHelperPreferencesStore
} from '../../store/helper-preferences-store'
import {
  SettingsCallout,
  SettingsCard,
  SettingsPage,
  SettingsSection,
  SettingsSelect,
  Toggle
} from './primitives'

/**
 * The Helpers page of the Agents group (PRDCT-4330): every one-shot model
 * call Clave makes on its own, one row each, on the machine the picker names.
 * The list is that machine's registry, so a helper declared later shows here
 * with no change to the page. The same component serves this Mac and a
 * server (`ServerPages.tsx` wraps it with the server's notice and accounts).
 */

function HelperRow({
  machine,
  helper,
  accounts
}: {
  machine: string
  helper: HelperPreference
  accounts: ReadonlyArray<{ id: string; label: string }>
}): ReactElement {
  const set = (patch: Parameters<typeof setHelperPreference>[2]): void =>
    void setHelperPreference(machine, helper.id, patch)
  return (
    <div className="settings-row" data-helper-row={helper.id}>
      <div className="min-w-0 flex-1">
        <p className="settings-row-title">{helper.label}</p>
        <p className="settings-row-description" data-helper-when-off={helper.id}>
          {helper.enabled ? helperDoes(helper.id) : helperWhenOff(helper.id)}
        </p>
        {helper.accountRemoved && (
          <p className="settings-row-description" data-helper-account-removed={helper.id}>
            {ACCOUNT_REMOVED}
          </p>
        )}
      </div>
      <div className="settings-row-controls">
        <SettingsSelect
          value={helper.model}
          options={helperModelChoices(helper)}
          onChange={(model) => set({ model: model === helper.defaultModel ? null : model })}
          ariaLabel={`${helper.label}: model`}
          disabled={!helper.enabled}
          testId={`helper-model-${helper.id}`}
        />
        <SettingsSelect
          value={accountValue(helper.account)}
          options={helperAccountChoices(accounts)}
          onChange={(value) => set({ account: accountFromValue(value) })}
          ariaLabel={`${helper.label}: account`}
          disabled={!helper.enabled}
          testId={`helper-account-${helper.id}`}
        />
        <Toggle
          checked={helper.enabled}
          onChange={(enabled) => set({ enabled })}
          ariaLabel={helper.label}
        />
      </div>
    </div>
  )
}

/** The page's body for one machine: its helpers, read when it opens. */
export function HelpersList({
  machine,
  machineName,
  accounts
}: {
  machine: string
  machineName: string
  accounts: ReadonlyArray<{ id: string; label: string }>
}): ReactElement {
  const state = useHelperPreferencesStore((s) => s.byMachine[machine] ?? EMPTY_MACHINE_HELPERS)
  useEffect(() => {
    void loadHelperPreferences(machine)
  }, [machine])
  let body: ReactNode
  if (state.status === 'error' && state.error === HELPERS_NEED_UPDATE)
    // An older server: nothing to try again, the update is the way.
    body = (
      <SettingsCallout
        role="status"
        title={HELPERS_NEED_UPDATE}
        text={`${machineName} runs a Clave server released before this page. Its helpers run on their own defaults until it is updated (Settings → Servers).`}
      />
    )
  else if (state.status === 'error' && state.helpers.length === 0)
    body = (
      <SettingsCallout
        tone="danger"
        role="alert"
        text={state.error ?? `${machineName} did not answer.`}
        actions={
          <button className="btn-secondary" onClick={() => void loadHelperPreferences(machine)}>
            Try again
          </button>
        }
      />
    )
  else
    body = (
      <SettingsCard data-helpers={machine}>
        {state.helpers.map((helper) => (
          <HelperRow key={helper.id} machine={machine} helper={helper} accounts={accounts} />
        ))}
        {state.helpers.length === 0 && (
          <div className="settings-row">
            <p className="settings-row-description">Reading…</p>
          </div>
        )}
      </SettingsCard>
    )
  return (
    <SettingsSection
      title="One-shot helpers"
      description={`Each runs one short call on ${machineName}, with no tool and no memory. By default it runs on the account of the tab it works for.`}
    >
      {body}
      {state.status !== 'error' && state.error && (
        <SettingsCallout tone="danger" role="alert" text={state.error} />
      )}
    </SettingsSection>
  )
}

/** This Mac's Helpers page. */
export function HelpersSettings(): ReactElement {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  return (
    <SettingsPage
      title="Helpers"
      description="The short model calls Clave makes on its own: tab titles, digests, commit messages. Turn one off, or move it to another model or account."
      testId="helpers"
    >
      <HelpersList machine={LOCAL_SERVER_ID} machineName="this Mac" accounts={profiles} />
    </SettingsPage>
  )
}
