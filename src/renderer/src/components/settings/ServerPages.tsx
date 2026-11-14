import { useEffect, useState, type ReactElement } from 'react'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import type { LauncherFamily } from '../../../../shared/agent-launch'
import { useSettingsServer } from '../../store/settings-machine-store'
import {
  deleteServerLaunchProfile,
  loadServerSettings,
  readServerUsage,
  refreshServerUsage,
  saveServerLaunchProfile,
  serverProfilesFor,
  setServerGlobalLaunchProfile,
  useServerSettingsStore,
  type ServerSettings
} from '../../store/server-settings-store'
import { useSessionStore } from '../../store/session-store'
import { describeClaudeProfileAuth } from '../../store/claude-profile-store'
import { describeCodexAccountAuth } from '../../store/codex-account-store'
import { formatAge, useUsageNavigation } from '../../store/usage-store'
import { useNow } from '../../lib/use-now'
import { QuotaOverview, ToolToggle, type QuotaProvider, type Tool } from '../usage/UsagePanel'
import { AgentsSettings, type LaunchProfileSource } from './AgentsSettings'
import { HelpersList } from './HelpersSettings'
import { IntegrationsList } from './IntegrationsSettings'
import { SettingsPage, SettingsCallout } from './primitives'
import { ConnectionsBoard } from './AccountsSettings'
import { ServerClaudeCard } from './ClaudeAccountsSection'
import { ServerCodexCard } from './CodexAccountsSection'

/**
 * The pages of the Agents group when the machine picker names a saved
 * Clave server (PRDCT-4152): the same pages as this Mac's, read from the
 * server's own settings over its connection. Accounts are read-only here,
 * since an account is signed in on the server itself; the launch profiles
 * are edited in place, the usage is read live, and Activity says plainly
 * that a server keeps no record yet.
 */

/** One server's settings, loaded when the page opens and when it reconnects. */
function useServerPage(serverId: string): {
  name: string
  connected: boolean
  stateLabel: string
  settings: ServerSettings
} {
  const server = useSettingsServer()
  const settings = useServerSettingsStore((s) => s.byServer[serverId] ?? EMPTY)
  const connected = server?.connected ?? false
  useEffect(() => {
    if (connected) void loadServerSettings(serverId)
  }, [serverId, connected])
  return {
    name: server?.connection.name ?? 'Clave server',
    connected,
    stateLabel: server ? stateOf(server.status?.state, server.connection.enabled) : 'Removed',
    settings
  }
}

const EMPTY: ServerSettings = {
  status: 'idle',
  error: null,
  claude: [],
  codex: [],
  migrated: [],
  profiles: null,
  usage: { claude: {}, codex: {} }
}

function stateOf(state: string | undefined, enabled: boolean): string {
  if (!enabled) return 'disconnected'
  switch (state) {
    case 'connected':
      return 'connected'
    case 'unauthorized':
      return 'refusing its token'
    case 'offline':
      return 'unreachable'
    default:
      return 'connecting'
  }
}

/** What a page says while the server is not there to answer. */
function ServerNotice({
  serverId,
  name,
  connected,
  stateLabel,
  settings
}: {
  serverId: string
  name: string
  connected: boolean
  stateLabel: string
  settings: ServerSettings
}): ReactElement | null {
  if (!connected)
    return (
      <SettingsCallout
        tone="danger"
        role="status"
        text={`${name} is ${stateLabel}. Its settings show once it is connected; Settings → Servers has the connection.`}
      />
    )
  if (settings.status === 'error')
    return (
      <SettingsCallout
        tone="danger"
        role="alert"
        text={settings.error ?? `${name} did not answer.`}
        actions={
          <button className="btn-secondary" onClick={() => void loadServerSettings(serverId)}>
            Try again
          </button>
        }
      />
    )
  return null
}

// ── Agents ──────────────────────────────────────────────────────────────────

export function ServerAgentsSettings({ serverId }: { serverId: string }): ReactElement {
  const page = useServerPage(serverId)
  const { settings } = page
  const source: LaunchProfileSource = {
    preferences: settings.profiles ?? {
      version: 1,
      customProfiles: [],
      globalDefaults: {},
      workspaceOverrides: {}
    },
    profilesFor: (family: LauncherFamily) => serverProfilesFor(settings, family),
    upsert: (profile) => saveServerLaunchProfile(serverId, profile),
    remove: (profileId) => deleteServerLaunchProfile(serverId, profileId),
    setGlobal: (family, profileId) => setServerGlobalLaunchProfile(serverId, family, profileId),
    workspaceId: null
  }
  if (!page.connected || settings.status === 'error')
    return (
      <SettingsPage title="Harnesses" description={`The launch profiles of ${page.name}.`}>
        <ServerNotice serverId={serverId} {...page} />
      </SettingsPage>
    )
  return (
    <div data-server-settings={serverId}>
      <AgentsSettings
        source={source}
        description={`The command each agent family launches with on ${page.name}. Keep passwords and API keys out of it: profiles are stored in plain text on the server.`}
      />
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The helpers of a server (PRDCT-4330): read and written on the server,
 *  whose runner reads them at each call; its own Claude accounts to pick. */
export function ServerHelpersSettings({ serverId }: { serverId: string }): ReactElement {
  const page = useServerPage(serverId)
  const { settings, name } = page
  return (
    <SettingsPage
      title="Helpers"
      description={`The short model calls Clave makes on its own on ${name}: tab titles, digests, commit messages. Turn one off, or move it to another model or account of the server.`}
      testId="helpers"
    >
      <div className="settings-page-sections" data-server-settings={serverId}>
        <ServerNotice serverId={serverId} {...page} />
        {page.connected && settings.status !== 'error' && (
          <HelpersList machine={serverId} machineName={name} accounts={settings.claude} />
        )}
      </div>
    </SettingsPage>
  )
}

// ── Integrations ────────────────────────────────────────────────────────────

/** The integrations of a server (PRDCT-4410): the ElevenLabs key is sealed
 *  on the server itself, by its own secret port, and checked from there. */
export function ServerIntegrationsSettings({ serverId }: { serverId: string }): ReactElement {
  const page = useServerPage(serverId)
  const { settings, name } = page
  return (
    <SettingsPage
      title="Integrations"
      description={`The services ${name} uses on your behalf, each with your own key.`}
      testId="integrations"
    >
      <div className="settings-page-sections" data-server-settings={serverId}>
        <ServerNotice serverId={serverId} {...page} />
        {page.connected && settings.status !== 'error' && (
          <IntegrationsList machine={serverId} machineName={name} />
        )}
      </div>
    </SettingsPage>
  )
}

// ── Accounts ────────────────────────────────────────────────────────────────

/**
 * A server's Connections page (PRDCT-4552): the same page as this Mac's, for
 * that server. Its Claude and Codex accounts are cards that only read (an
 * account is signed in where its login runs, on the server); its provider
 * connections are made, renamed, keyed and removed from here, their keys
 * sealed on the server by its own secret port.
 */
export function ServerAccountsSettings({ serverId }: { serverId: string }): ReactElement {
  const page = useServerPage(serverId)
  const { settings, name } = page
  const live = page.connected && settings.status !== 'error'
  const claudeExtra = settings.claude.filter((a) => a.id !== 'default').length
  const codexShown = settings.codex.filter((a) => a.id !== 'default' || a.hasCredential)
  return (
    <SettingsPage
      title="Connections"
      description={`What sessions started on ${name} run on: the Claude and Codex accounts signed in there, in the order they are taken, and the keys stored there, each with the models it serves.`}
      testId="accounts"
    >
      <div className="settings-page-sections" data-server-settings={serverId}>
        <ServerNotice serverId={serverId} {...page} />
        {live && (
          <>
            <ConnectionsBoard
              machine={serverId}
              machineName={name}
              connectedCount={claudeExtra + codexShown.length}
              codexReady={codexShown.some((a) => a.hasCredential)}
              accounts={(modelsOf) => (
                <>
                  <ServerClaudeCard
                    accounts={settings.claude}
                    migrated={settings.migrated}
                    usage={settings.usage.claude}
                    machine={name}
                  />
                  <ServerCodexCard
                    accounts={codexShown}
                    usage={settings.usage.codex}
                    models={modelsOf('openai')}
                    machine={name}
                  />
                </>
              )}
            />
            <SettingsCallout
              tone="accent"
              title="Accounts are signed in on the server itself"
              text={
                <>
                  An account is added where its login runs. On {name}, from the installed release,
                  run{' '}
                  <code className="text-text-primary">
                    node ~/.local/lib/clave-server/current/scripts/server-accounts.mjs claude add
                    &lt;name&gt;
                  </code>{' '}
                  with the token of <code className="text-text-primary">claude setup-token</code> on
                  its input, or <code className="text-text-primary">codex add-key</code> with an API
                  key. This list follows the server.
                </>
              }
            />
          </>
        )}
      </div>
    </SettingsPage>
  )
}

// ── Usage ───────────────────────────────────────────────────────────────────

const SERVER_TOOLS: readonly Tool[] = ['claude', 'codex']

/** The page's Refresh for a server: every account of the provider on
 *  screen read live on the server, and how old the numbers are. */
function ServerUsageRefresh({
  serverId,
  settings,
  tool
}: {
  serverId: string
  settings: ServerSettings
  tool: QuotaProvider
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const now = useNow(15_000)
  const visible = Object.values(settings.usage[tool])
  // The age of the numbers on screen: a failed read shows none, so it
  // counts for nothing here.
  const reads = visible
    .filter((s) => s.status === 'ready')
    .map((s) => s.fetchedAt)
    .filter((at): at is number => typeof at === 'number')
  const spinning = busy || visible.some((s) => s.refreshing)
  const age = reads.length > 0 ? formatAge(Math.min(...reads), now) : null
  return (
    <div className="flex items-center gap-2" data-usage-refresh>
      {age && (
        <span className="text-xs text-text-tertiary tabular-nums" data-usage-age>
          {spinning ? 'Reading…' : `Updated ${age}`}
        </span>
      )}
      <button
        onClick={() => {
          setBusy(true)
          void refreshServerUsage(serverId, tool).finally(() => setBusy(false))
        }}
        disabled={spinning}
        className="btn-secondary"
        aria-label="Refresh usage"
        title="Read every account again now, on the server"
      >
        <ArrowPathIcon className={`w-3.5 h-3.5 ${spinning ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  )
}

export function ServerUsageSettings({ serverId }: { serverId: string }): ReactElement {
  const page = useServerPage(serverId)
  const { settings, name } = page
  const picked = useUsageNavigation((s) => s.provider) ?? 'claude'
  const setTool = useUsageNavigation((s) => s.select)
  // A server answers for Claude and Codex; a Pi or Antigravity pick made on
  // this Mac's page falls to Claude here.
  const tool: QuotaProvider = picked === 'codex' ? 'codex' : 'claude'
  const accounts =
    tool === 'claude'
      ? settings.claude.map((a) => ({
          id: a.id,
          label: a.label,
          auth: describeClaudeProfileAuth(a)
        }))
      : settings.codex.map((a) => ({ id: a.id, label: a.label, auth: describeCodexAccountAuth(a) }))
  return (
    <SettingsPage
      title="Usage"
      description={`How much of each account's limits is used on ${name}, and when each one resets. Read on the server every five minutes.`}
      actions={
        page.connected && <ServerUsageRefresh serverId={serverId} settings={settings} tool={tool} />
      }
    >
      <div className="settings-page-sections" data-server-settings={serverId}>
        <ServerNotice serverId={serverId} {...page} />
        {page.connected && settings.status !== 'error' && (
          <div className="space-y-6" data-usage-provider={tool}>
            <ToolToggle tool={tool} onChange={setTool} tools={SERVER_TOOLS} />
            <QuotaOverview
              provider={tool}
              accounts={accounts}
              byAccount={settings.usage[tool]}
              load={(id) => void readServerUsage(serverId, tool, id, false)}
              onRetry={() => void refreshServerUsage(serverId, tool)}
            />
          </div>
        )}
      </div>
    </SettingsPage>
  )
}

// ── Activity ────────────────────────────────────────────────────────────────

export function ServerActivitySettings({ serverId }: { serverId: string }): ReactElement {
  const page = useServerPage(serverId)
  const setSettingsSection = useSessionStore((s) => s.setSettingsSection)
  return (
    <SettingsPage
      title="Activity"
      description={`When sessions ran on ${page.name}, how many at once, and how much of the day they covered.`}
    >
      <div data-server-settings={serverId}>
        <SettingsCallout
          role="status"
          title={`${page.name} keeps no activity record yet`}
          text="Activity is recorded by the Clave app on the Mac whose sessions it shows. A Clave server running on its own does not record its sessions yet, so there is nothing to show for it here; the Activity of this Mac is under This Mac in the picker."
          actions={
            <button className="btn-secondary" onClick={() => setSettingsSection('servers')}>
              Open Servers
            </button>
          }
          className="server-activity-unavailable"
        />
        <div data-testid="server-activity-unavailable" hidden />
      </div>
    </SettingsPage>
  )
}
