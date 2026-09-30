import { useEffect, type ReactElement } from 'react'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Radio,
  SettingsSelect
} from './primitives'
import { ClaudeAccountsSection } from './ClaudeAccountsSection'
import { CodexAccountsSection } from './CodexAccountsSection'
import { loadAccountLogins } from '../../store/account-login-store'
import { useAccountPolicyStore, type AccountSwitchMode } from '../../store/account-policy-store'
import { useWorkspaceStore } from '../../store/workspace-store'

/** The policy's knobs (ADR 0002): what a tab does when its account is about
 *  to hit its limit, for every workspace and for this one. */
function SwitchPolicySection(): ReactElement {
  const mode = useAccountPolicyStore((s) => s.mode)
  const byWorkspace = useAccountPolicyStore((s) => s.byWorkspace)
  const setMode = useAccountPolicyStore((s) => s.setMode)
  const setWorkspaceMode = useAccountPolicyStore((s) => s.setWorkspaceMode)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaceName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.name ?? null
  )
  const own = activeWorkspaceId ? (byWorkspace[activeWorkspaceId] ?? '') : ''
  const choices: { value: AccountSwitchMode; label: string; description: string }[] = [
    {
      value: 'propose',
      label: 'Propose the switch',
      description:
        'The tab shows where it would go and waits for you. A working agent is never interrupted.'
    },
    {
      value: 'automatic',
      label: 'Switch automatically',
      description:
        'The tab moves to the next account of the pool as soon as its agent is idle, the conversation resumed there.'
    }
  ]
  return (
    <SettingsSection
      title="When an account hits its limit"
      description="What a tab does when the account it runs on is about to stop it, or its agent reports the limit. A tab pinned from its menu never moves; a tab can also carry a mode of its own."
    >
      <SettingsCard data-account-policy>
        {choices.map((choice) => (
          <div className="settings-row" key={choice.value} data-account-policy-mode={choice.value}>
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <Radio
                checked={mode === choice.value}
                onSelect={() => setMode(choice.value)}
                ariaLabel={choice.label}
              />
              <div className="min-w-0">
                <p className="settings-row-title">{choice.label}</p>
                <p className="settings-row-description">{choice.description}</p>
              </div>
            </div>
          </div>
        ))}
        {activeWorkspaceId && (
          <SettingsRow
            label={`This workspace${workspaceName ? ` · ${workspaceName}` : ''}`}
            description="Its own mode, over the one above."
          >
            <SettingsSelect<AccountSwitchMode | 'default'>
              value={own || 'default'}
              ariaLabel="This workspace's switching mode"
              options={[
                { value: 'default', label: 'Same as every workspace' },
                { value: 'propose', label: 'Propose the switch' },
                { value: 'automatic', label: 'Switch automatically' }
              ]}
              onChange={(value) =>
                setWorkspaceMode(activeWorkspaceId, value === 'default' ? null : value)
              }
              testId="account-policy-workspace"
            />
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

/**
 * Settings → Accounts (ADR 0002): the subscriptions Clave can run a session
 * on, per provider, in the order the pool walks them, each signed in from
 * here. Usage per account is read on the Usage page; this page is where an
 * account is added, logged into, ordered and removed.
 */
export function AccountsSettings(): ReactElement {
  useEffect(() => {
    void loadAccountLogins()
  }, [])
  return (
    <SettingsPage
      title="Accounts"
      description="The subscriptions Clave can run sessions on. New sessions start on the selected account and move along the list when it is about to hit its limit; a running tab is switched from its menu, its conversation resumed on the other account."
      testId="accounts"
    >
      <ClaudeAccountsSection />
      <CodexAccountsSection />
      <SwitchPolicySection />
    </SettingsPage>
  )
}
