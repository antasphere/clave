import { useEffect, useState, type ReactElement } from 'react'
import * as DropdownMenuPrimitive from '@clave/ui/primitives/dropdown-menu'
import { ClipboardDocumentIcon, KeyIcon, PlusIcon } from '@heroicons/react/24/outline'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Radio,
  SettingsSelect,
  ToggleRow
} from './primitives'
import { AntasphereAccountSection } from './AntasphereAccountSection'
import { ClaudeAccountsSection } from './ClaudeAccountsSection'
import { CodexAccountsSection } from './CodexAccountsSection'
// ── Lane B (harness wave): provider connections (PRDCT-4426) ──
import { ProviderConnectItems, ProviderConnectionsSections } from './ProviderConnectionsSection'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { ProviderCompanyId } from '../../../../preload/index.d'
import {
  CONNECTION_COMPANIES,
  connectAnthropic,
  connectOpenAI,
  type ConnectionCompany
} from './connection-companies'
import { loadAccountLogins } from '../../store/account-login-store'
import {
  useAccountPolicyStore,
  type AccountSwitchMode,
  type FamilyLimitRule
} from '../../store/account-policy-store'
import { useWorkspaceStore } from '../../store/workspace-store'

/** The policy's knobs (ADR 0002): what a tab does when its account is about
 *  to hit its limit, for every workspace and for this one. */
function SwitchPolicySection(): ReactElement {
  const mode = useAccountPolicyStore((s) => s.mode)
  const byWorkspace = useAccountPolicyStore((s) => s.byWorkspace)
  const setMode = useAccountPolicyStore((s) => s.setMode)
  const setWorkspaceMode = useAccountPolicyStore((s) => s.setWorkspaceMode)
  const onFamilyLimit = useAccountPolicyStore((s) => s.onFamilyLimit)
  const familyByWorkspace = useAccountPolicyStore((s) => s.familyByWorkspace)
  const setOnFamilyLimit = useAccountPolicyStore((s) => s.setOnFamilyLimit)
  const setWorkspaceOnFamilyLimit = useAccountPolicyStore((s) => s.setWorkspaceOnFamilyLimit)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaceName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.name ?? null
  )
  const own = activeWorkspaceId ? (byWorkspace[activeWorkspaceId] ?? '') : ''
  const ownFamily = activeWorkspaceId ? (familyByWorkspace[activeWorkspaceId] ?? '') : ''
  const familyChoices: { value: FamilyLimitRule; label: string }[] = [
    { value: 'switch-model', label: 'Continue on another model of the same account' },
    { value: 'switch-account', label: 'Switch to another connection' }
  ]
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
        'The tab moves to the next connection of the pool as soon as its agent is idle, the conversation resumed there.'
    }
  ]
  return (
    <SettingsSection
      title="When a connection hits its limit"
      description="What a tab does when the connection it runs on is about to stop it, or its agent reports the limit. A tab pinned from its menu never moves; a tab can also carry a mode of its own. On a tab running on a Clave server the mode governs only an agent's switch: Switch automatically lets agents move it without asking, and a server tab at its limit is never moved by itself."
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
        <SettingsRow
          label="When one model's cap is out"
          description="A subscription meters each model family's week on its own. With the Fable week spent and the rest open, the tab is offered Opus 5.5 on the same connection before another connection; this is what the automatic mode takes. A tab kept on its model from its menu falls to the connection."
        >
          <SettingsSelect<FamilyLimitRule>
            value={onFamilyLimit}
            ariaLabel="What happens when one model family's cap is out"
            options={familyChoices}
            onChange={(value) => setOnFamilyLimit(value)}
            testId="account-policy-family"
          />
        </SettingsRow>
        {activeWorkspaceId && (
          <SettingsRow
            label={`This workspace${workspaceName ? ` · ${workspaceName}` : ''}, one model's cap`}
            description="Its own rule, over the one above."
          >
            <SettingsSelect<FamilyLimitRule | 'default'>
              value={ownFamily || 'default'}
              ariaLabel="This workspace's rule when one model family's cap is out"
              options={[{ value: 'default', label: 'Same as every workspace' }, ...familyChoices]}
              onChange={(value) =>
                setWorkspaceOnFamilyLimit(activeWorkspaceId, value === 'default' ? null : value)
              }
              testId="account-policy-family-workspace"
            />
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

/** Bring a connection's row into view once it is drawn (the login flow
 *  opens under it). */
function revealRow(selector: string): void {
  requestAnimationFrame(() =>
    document.querySelector(selector)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  )
}

/**
 * The page's one way in: Connect, then the company. Picking one starts its
 * browser sign-in (the hidden terminal of `claude setup-token` or
 * `codex login`); the secondary road under each company opens the paste
 * form instead. The only place the words of the mechanism appear.
 */
function ConnectMenu({
  onPick,
  onSecondary,
  onProvider
}: {
  onPick: (company: ConnectionCompany) => void
  onSecondary: (company: ConnectionCompany) => void
  onProvider: (id: ProviderCompanyId) => void
}): ReactElement {
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild>
        <button type="button" className="btn-primary" data-connect>
          <PlusIcon className="w-3.5 h-3.5" />
          Connect
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="menu-surface menu-pop select-menu z-50 p-1"
          data-connect-chooser
        >
          {CONNECTION_COMPANIES.map((company, index) => (
            <div key={company.id}>
              {index > 0 && <DropdownMenuPrimitive.Separator className="menu-sep" />}
              <DropdownMenuPrimitive.Item
                className="menu-item select-option"
                onSelect={() => onPick(company)}
                data-connect-company={company.id}
              >
                <company.Logo className="w-4 h-4 flex-shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{company.name}</span>
                  <span className="block truncate text-[11px] text-text-tertiary">
                    {company.hint}
                  </span>
                </span>
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className="menu-item select-option text-[11px] text-text-tertiary"
                onSelect={() => onSecondary(company)}
                data-connect-secondary={company.id}
              >
                {company.pool === 'claude' ? (
                  <ClipboardDocumentIcon className="w-3.5 h-3.5 flex-shrink-0" />
                ) : (
                  <KeyIcon className="w-3.5 h-3.5 flex-shrink-0" />
                )}
                {company.pool === 'claude' ? 'Paste a token instead' : 'Use an API key instead'}
              </DropdownMenuPrimitive.Item>
            </div>
          ))}
          {/* ── Lane B (harness wave): the providers, connected with a key (PRDCT-4426) ── */}
          <DropdownMenuPrimitive.Separator className="menu-sep" />
          <ProviderConnectItems onPick={onProvider} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

/**
 * Settings → Connections (PRDCT-4424): the Antasphere account this Clave is
 * signed in with (PRDCT-3259, optional, Clave only), then who pays for what
 * the harnesses run: the subscriptions Clave can run a session on (ADR
 * 0002), per company, in the order the pool walks them, each connected from
 * here. Usage per connection is read on the Usage page; this page is where a
 * connection is added, signed in, ordered and removed.
 */
export function AccountsSettings(): ReactElement {
  const useRecommendedAccount = useAccountPolicyStore((s) => s.useRecommendedAccount)
  const setUseRecommendedAccount = useAccountPolicyStore((s) => s.setUseRecommendedAccount)
  const [pasteRequest, setPasteRequest] = useState(0)
  const [keyRequest, setKeyRequest] = useState(0)
  const [addRequest, setAddRequest] = useState<ProviderCompanyId | null>(null)
  useEffect(() => {
    void loadAccountLogins()
  }, [])
  const pick = async (company: ConnectionCompany): Promise<void> => {
    const id = company.pool === 'claude' ? await connectAnthropic() : await connectOpenAI()
    if (id)
      revealRow(
        company.pool === 'claude'
          ? `[data-claude-account-row="${id}"]`
          : `[data-codex-account-row="${id}"]`
      )
  }
  const secondary = (company: ConnectionCompany): void => {
    if (company.pool === 'claude') {
      setPasteRequest((n) => n + 1)
      revealRow('[data-claude-token-form]')
    } else {
      setKeyRequest((n) => n + 1)
      revealRow('[data-codex-api-key-form]')
    }
  }
  return (
    <SettingsPage
      title="Connections"
      description="Your Antasphere account, which signs you into Clave itself, and who pays for what your harnesses run: the subscriptions Clave can run sessions on. Choose how new sessions pick a connection; a running tab is switched from its menu, its conversation resumed on the other connection."
      testId="accounts"
      actions={
        <ConnectMenu
          onPick={(company) => void pick(company)}
          onSecondary={secondary}
          onProvider={(id) => {
            setAddRequest(id)
            revealRow(`[data-provider-add-form="${id}"]`)
          }}
        />
      }
    >
      <AntasphereAccountSection />
      <ClaudeAccountsSection pasteRequest={pasteRequest} />
      <CodexAccountsSection keyRequest={keyRequest} />
      <ProviderConnectionsSections
        machine={LOCAL_SERVER_ID}
        addRequest={addRequest}
        onAddDone={() => setAddRequest(null)}
      />
      <SettingsSection title="New sessions">
        <SettingsCard>
          <ToggleRow
            label="Use the recommended connection for new sessions"
            description="For Claude and Codex, use the same recommendation as Switch account: a usable subscription whose weekly allowance resets soonest. A connection you choose explicitly takes priority."
            checked={useRecommendedAccount}
            onChange={setUseRecommendedAccount}
          />
        </SettingsCard>
      </SettingsSection>
      <SwitchPolicySection />
    </SettingsPage>
  )
}
