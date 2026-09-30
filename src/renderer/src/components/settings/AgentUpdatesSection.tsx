import { ArrowDownTrayIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { useAgentUpdatesStore } from '../../store/agent-updates-store'
import type { AgentUpdateId, AgentUpdateStatus } from '../../../../shared/agent-updates'
import { agentStatusLine, installLabel, timeOf } from '../../lib/agent-update-status'
import { ClaudeLogo, AntigravityLogo, CodexLogo, PiLogo } from '../icons/cli-logos'
import {
  SettingsCallout,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  ToggleRow
} from './primitives'

const LOGOS: Record<AgentUpdateId, (p: { className?: string }) => React.JSX.Element> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  antigravity: AntigravityLogo,
  pi: PiLogo
}

function AgentRow({
  agent,
  autoUpdate,
  onUpdate
}: {
  agent: AgentUpdateStatus
  autoUpdate: boolean
  onUpdate: () => void
}): React.JSX.Element {
  const Logo = LOGOS[agent.id]
  const badge = installLabel(agent.install)
  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <Logo className="w-4 h-4 flex-shrink-0" />
          <span>
            {agent.name}
            {agent.currentVersion ? ` ${agent.currentVersion}` : ''}
          </span>
          {badge && <span className="badge badge-muted">{badge}</span>}
        </span>
      }
      description={
        <span data-agent-update-status={agent.id}>
          {agentStatusLine(agent, autoUpdate)}
          {agent.error && (
            <span className="status-text block break-words" data-status="error">
              {agent.error}
            </span>
          )}
        </span>
      }
    >
      {agent.updateAvailable && (
        <button
          onClick={onUpdate}
          disabled={agent.phase !== 'idle'}
          className="btn-secondary"
          data-agent-update-button={agent.id}
        >
          <ArrowDownTrayIcon className="w-3.5 h-3.5" />
          {agent.phase === 'updating' ? 'Updating…' : 'Update'}
        </button>
      )}
    </SettingsRow>
  )
}

/**
 * Settings → Software Update → Agents: the agent CLIs Clave launches, each
 * with how it was installed, its version and its state, and the one switch
 * between upgrading them on its own and only saying an upgrade exists.
 */
export function AgentUpdatesSection(): React.JSX.Element {
  const { supported, autoUpdate, busy, agents, check, update, setAutoUpdate } =
    useAgentUpdatesStore()
  const lastChecked = agents.reduce<number | null>(
    (latest, a) =>
      a.lastCheckedAt && (!latest || a.lastCheckedAt > latest) ? a.lastCheckedAt : latest,
    null
  )
  return (
    <SettingsSection
      title="Agents"
      description="The agent command-line tools Clave launches, each upgraded by the installer that put it on this Mac. New sessions start on the new release; open tabs are never interrupted."
    >
      {!supported ? (
        <SettingsCallout
          tone="accent"
          title="Not on Windows yet"
          text="Clave keeps agents current on macOS and Linux. On Windows, update them with the installer you used."
        />
      ) : (
        <SettingsCard>
          <ToggleRow
            label="Update agents automatically"
            description="Checks at launch and every six hours, and installs new releases in the background. Off, Clave only tells you."
            checked={autoUpdate}
            onChange={(value) => void setAutoUpdate(value)}
          />
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              autoUpdate={autoUpdate}
              onUpdate={() => void update(agent.id)}
            />
          ))}
          <SettingsRow label="Last checked">
            <button
              onClick={() => void check()}
              disabled={busy}
              className="btn-secondary"
              data-agent-updates-check
            >
              <ArrowPathIcon className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              {busy ? 'Working…' : 'Check Agents'}
            </button>
            <span className="settings-row-value">
              {lastChecked ? timeOf(lastChecked).replace(/^today/, 'Today') : 'Never'}
            </span>
          </SettingsRow>
        </SettingsCard>
      )}
    </SettingsSection>
  )
}
