import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
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
import { ClaudeAccountsCard } from './ClaudeAccountsSection'
import { CodexAccountsCard } from './CodexAccountsSection'
import { ProviderConnectionCards } from './ProviderConnectionsSection'
import { codexAccountShown, useProviderMachine } from './connection-actions'
import { ConnectionOffers } from './ConnectionOffers'
import type { CardModels } from './ConnectionCard'
import { machineWords, type CardCompany } from './connection-cards'
import { useCodexModels, useMachineCatalog } from './connection-models'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { catalogModelsOf } from '@clave/contract/settings/models-catalog-view'
import { PROVIDER_LISTING_FACTS } from '../../../../main/models-catalog-overlay'
import { CLAUDE_MODELS } from '../../../../shared/claude-models'
import { useClaudeProfileStore } from '../../store/claude-profile-store'
import { useCodexAccountStore } from '../../store/codex-account-store'
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

/** How a card says it has no model list, per company. */
const NO_LIST: Partial<Record<CardCompany, string>> = {
  ollama: 'Whatever your Ollama serves',
  generic: 'Whatever your endpoint serves'
}

/**
 * The models each card names, for one machine: Claude's by name, Codex's as
 * the CLI lists them (asked once a Codex connection can answer), and each
 * provider's from the machine's models catalogue (models.dev, deprecated ones
 * hidden). Ollama and another provider have no list Clave can read: their
 * cards say so.
 */
function useCardModels(machine: string, codexReady: boolean): (company: CardCompany) => CardModels {
  const catalog = useMachineCatalog(machine)
  const codex = useCodexModels(codexReady)
  return (company) => {
    if (company === 'anthropic') return { names: CLAUDE_MODELS.map((m) => m.name) }
    if (company === 'openai') {
      if (!codexReady) return { note: 'Listed once Codex is signed in' }
      if (codex.failed) return { note: 'Codex did not list them from here' }
      if (!codex.models) return 'loading'
      return { names: codex.models.map((m) => m.label) }
    }
    const catalogId = PROVIDER_LISTING_FACTS[company].catalog
    if (!catalogId) return { note: NO_LIST[company] ?? 'No list to read' }
    if (catalog === 'loading') return 'loading'
    if (catalog === null) return { note: 'The models list could not be read' }
    return { names: catalogModelsOf(catalog, catalogId).map((m) => m.name) }
  }
}

/** The two sections every Connections page opens on, this Mac's and a
 *  server's alike: what is connected, then every provider that can be. */
export function ConnectionsBoard({
  machine,
  machineName,
  accounts,
  connectedCount,
  codexReady
}: {
  machine: string
  /** The server's name, or null for this Mac. */
  machineName: string | null
  /** The machine's account cards (Claude, then Codex), in pool order, given
   *  the models each company serves. */
  accounts: (modelsOf: (company: CardCompany) => CardModels) => ReactNode
  /** How many connections the machine has beyond its own logins. */
  connectedCount: number
  codexReady: boolean
}): ReactElement {
  const words = machineWords(machineName)
  const modelsOf = useCardModels(machine, codexReady)
  const providers = useProviderMachine(machine)
  const [adding, setAdding] = useState<{ machine: string; open: boolean }>({
    machine,
    open: false
  })
  const total = connectedCount + providers.connections.length
  const where = machineName ? `on ${machineName}` : 'here'
  return (
    <>
      <SettingsSection
        title="Connected"
        description={
          total === 0
            ? `Nothing connected ${where} yet beyond the machine’s own login. Connect a provider below: each card says which harnesses run on it and which models it serves.`
            : machineName
              ? `What new sessions on ${machineName} can run on. Claude Code and Codex take the first connection of their company and move along when it nears its limit; Pi and OpenCode tabs pick theirs in the launcher.`
              : 'What new sessions can run on. Claude Code and Codex start on the connection marked and move along when it nears its limit; Pi and OpenCode tabs pick theirs in the launcher.'
        }
      >
        <div
          className="connection-stack"
          data-connections-connected={machine}
          data-connections-count={total}
        >
          {accounts(modelsOf)}
          <ProviderConnectionCards
            machine={machine}
            machineWords={words}
            modelsOf={modelsOf}
            addOpen={adding.machine === machine && adding.open}
          />
        </div>
      </SettingsSection>
      <SettingsSection
        title="Connect a provider"
        description={
          machineName
            ? `Store a key once on ${machineName}; it is sealed there and never shown again. Its subscriptions are signed in on the server itself.`
            : 'Sign in to a subscription, or store a key once: it is sealed on this Mac and never shown again.'
        }
      >
        <ConnectionOffers
          machine={machine}
          subscriptions={machineName === null}
          modelsOf={modelsOf}
          onOpenChange={(open) => setAdding({ machine, open })}
        />
      </SettingsSection>
    </>
  )
}

/**
 * Settings → Connections (PRDCT-4424, as cards since PRDCT-4552): the page
 * answers "what can I run on, and with what" at a glance. What is connected
 * reads first, one card per provider with its connections as rows (a Claude
 * account, a Codex account and a stored provider connection alike); then
 * every provider not connected yet, a card each, connected from the card
 * itself. Below them, as they were: the
 * Antasphere account this Clave is signed in with (PRDCT-3259, optional,
 * Clave only), how new sessions pick a connection, and the switch policy.
 */
export function AccountsSettings(): ReactElement {
  const useRecommendedAccount = useAccountPolicyStore((s) => s.useRecommendedAccount)
  const setUseRecommendedAccount = useAccountPolicyStore((s) => s.setUseRecommendedAccount)
  const claudeCount = useClaudeProfileStore((s) => s.profiles.length - 1)
  const codexAccounts = useCodexAccountStore((s) => s.accounts)
  const codexShown = codexAccounts.filter(codexAccountShown).length
  const codexReady = codexAccounts.some((a) => a.hasCredential)
  useEffect(() => {
    void loadAccountLogins()
  }, [])
  return (
    <SettingsPage
      title="Connections"
      description="What your sessions run on: the subscriptions and the keys Clave can start a harness on, each with the models it serves. A running tab is switched from its menu, its conversation resumed on the other connection. Your Antasphere account, which signs you into Clave itself, is below."
      testId="accounts"
    >
      <ConnectionsBoard
        machine={LOCAL_SERVER_ID}
        machineName={null}
        connectedCount={claudeCount + codexShown}
        codexReady={codexReady}
        accounts={(modelsOf) => (
          <>
            <ClaudeAccountsCard machine={machineWords(null)} />
            {codexShown > 0 && (
              <CodexAccountsCard machine={machineWords(null)} models={modelsOf('openai')} />
            )}
          </>
        )}
      />
      <AntasphereAccountSection />
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
