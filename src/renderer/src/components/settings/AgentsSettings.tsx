import { useState } from 'react'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CommandLineIcon,
  PlusIcon,
  TrashIcon
} from '@heroicons/react/24/outline'
import {
  deleteLaunchProfile,
  profilesFor,
  saveLaunchProfile,
  setGlobalLaunchProfile,
  setWorkspaceLaunchProfile,
  useLaunchProfileStore
} from '../../store/launch-profile-store'
import { getLastAgentSetup, rememberAgentSetup } from '../../store/launch-prefs'
import { useWorkspaceStore } from '../../store/workspace-store'
import { restartConversationService } from '../../lib/session-migration'
import type {
  LaunchProfile,
  LauncherFamily,
  PiThinkingLevel
} from '../../../../shared/agent-launch'
import { ClaudeLogo, AntigravityLogo, CodexLogo, PiLogo } from '../icons/cli-logos'
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect
} from './primitives'

const FAMILIES: {
  id: LauncherFamily
  label: string
  Logo: (p: { className?: string }) => React.JSX.Element
}[] = [
  { id: 'claude', label: 'Claude', Logo: ClaudeLogo },
  { id: 'antigravity', label: 'Antigravity', Logo: AntigravityLogo },
  { id: 'codex', label: 'Codex', Logo: CodexLogo },
  { id: 'pi', label: 'Pi', Logo: PiLogo }
]
const THINKING: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** The select's value for "the Pi default": a select's value is a string, and
 *  the profile carries no thinking level when Pi decides. */
const PI_DEFAULT = '__default__'
/** The select's value for "no override" on a workspace. */
const USE_GLOBAL = '__global__'

function TokenEditor({
  label,
  tokens,
  onChange
}: {
  label: string
  tokens: string[]
  onChange: (tokens: string[]) => void
}): React.JSX.Element {
  const replace = (index: number, token: string): void => {
    const next = [...tokens]
    next[index] = token
    onChange(next)
  }
  const move = (index: number, offset: number): void => {
    const target = index + offset
    if (target < 0 || target >= tokens.length) return
    const next = [...tokens]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  return (
    <div className="settings-row items-start">
      <div className="settings-row-title pt-1.5 w-40 flex-shrink-0">{label}</div>
      <div className="flex-1 space-y-1.5 min-w-0">
        {tokens.map((token, index) => (
          <div key={index} className="flex gap-1">
            <input
              className="input-compact flex-1 font-mono"
              value={token}
              onChange={(event) => replace(index, event.target.value)}
              aria-label={`${label} token ${index + 1}`}
            />
            <button
              className="btn-icon btn-icon-md"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              title="Move up"
              aria-label="Move up"
            >
              <ArrowUpIcon className="w-4 h-4" />
            </button>
            <button
              className="btn-icon btn-icon-md"
              onClick={() => move(index, 1)}
              disabled={index === tokens.length - 1}
              title="Move down"
              aria-label="Move down"
            >
              <ArrowDownIcon className="w-4 h-4" />
            </button>
            <button
              className="btn-icon btn-icon-md btn-icon--danger"
              onClick={() => onChange(tokens.filter((_, i) => i !== index))}
              title="Remove token"
              aria-label="Remove token"
            >
              <TrashIcon className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button className="btn-secondary" onClick={() => onChange([...tokens, ''])}>
          <PlusIcon className="w-3.5 h-3.5" /> Add token
        </button>
      </div>
    </div>
  )
}

function ProfileEditor({
  profile,
  onDone
}: {
  profile: LaunchProfile
  onDone: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(profile)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    try {
      await saveLaunchProfile({
        ...draft,
        name: draft.name.trim(),
        command: draft.command.filter((token) => token.length > 0),
        additionalArgs: draft.additionalArgs.filter((token) => token.length > 0)
      })
      onDone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this profile')
    }
  }
  return (
    <SettingsCard className="mt-2" data-launch-profile-editor>
      <SettingsRow label="Name">
        <input
          className="input-compact w-56"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          aria-label="Profile name"
        />
      </SettingsRow>
      <TokenEditor
        label="Command"
        tokens={draft.command}
        onChange={(command) => setDraft({ ...draft, command })}
      />
      <TokenEditor
        label="Additional arguments"
        tokens={draft.additionalArgs}
        onChange={(additionalArgs) => setDraft({ ...draft, additionalArgs })}
      />
      {draft.family === 'pi' && (
        <>
          <SettingsRow label="Provider" description="Optional Pi provider id">
            <input
              className="input-compact w-56"
              value={draft.pi?.provider ?? ''}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  pi: { ...draft.pi, provider: event.target.value || undefined }
                })
              }
              aria-label="Pi provider id"
            />
          </SettingsRow>
          <SettingsRow label="Model" description="Optional Pi model id">
            <input
              className="input-compact w-56"
              value={draft.pi?.model ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, pi: { ...draft.pi, model: event.target.value || undefined } })
              }
              aria-label="Pi model id"
            />
          </SettingsRow>
          <SettingsRow label="Thinking">
            <SettingsSelect
              value={draft.pi?.thinking ?? PI_DEFAULT}
              options={[
                { value: PI_DEFAULT, label: 'Pi default' },
                ...THINKING.map((level) => ({ value: level, label: level }))
              ]}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  pi: {
                    ...draft.pi,
                    thinking: value === PI_DEFAULT ? undefined : (value as PiThinkingLevel)
                  }
                })
              }
              ariaLabel="Pi thinking level"
              testId="pi-thinking"
            />
          </SettingsRow>
        </>
      )}
      {error && <div className="px-3.5 py-2 text-xs text-destructive">{error}</div>}
      <div className="settings-row justify-end gap-2">
        <button className="btn-secondary" onClick={onDone}>
          Cancel
        </button>
        <button className="btn-primary" onClick={() => void save()}>
          Save profile
        </button>
      </div>
    </SettingsCard>
  )
}

export function AgentsSettings(): React.JSX.Element {
  const preferences = useLaunchProfileStore((state) => state.preferences)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const [editing, setEditing] = useState<LaunchProfile | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState('')
  const restart = async (): Promise<void> => {
    setRestarting(true)
    setRestartError('')
    try {
      await restartConversationService()
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : String(error))
    } finally {
      setRestarting(false)
    }
  }
  const families = [...FAMILIES]
  for (const profile of [...(preferences.defaultProfiles ?? []), ...preferences.customProfiles]) {
    if (!families.some((family) => family.id === profile.family)) {
      families.push({
        id: profile.family,
        label:
          preferences.defaultProfiles?.find((item) => item.family === profile.family)?.name ??
          profile.family,
        Logo: () => <CommandLineIcon className="w-4 h-4" />
      })
    }
  }
  const setWorkspaceDefault = async (
    workspaceId: string,
    family: LauncherFamily,
    profileId: string | null
  ): Promise<void> => {
    await setWorkspaceLaunchProfile(workspaceId, family, profileId)
    const setup = getLastAgentSetup(workspaceId)
    const setupFamily = setup.kind === 'claude-agents' ? 'claude' : setup.kind
    if (setupFamily !== family) return
    rememberAgentSetup(workspaceId, {
      ...setup,
      launchProfileId: profileId ?? undefined
    })
  }
  return (
    <SettingsPage
      title="Agents"
      description="One launch profile per agent family: the command Clave runs and its arguments. Commands are stored locally as argument tokens; never put a password or an API key in them."
    >
      <SettingsSection title="Background service">
        <SettingsCard>
          <SettingsRow
            label="Restart conversation service"
            description="Recover after a service update. Clave asks before interrupting active work. Providers stay stopped until you send a message."
          >
            <button className="btn-secondary" disabled={restarting} onClick={() => void restart()}>
              {restarting ? 'Restarting…' : 'Restart background service'}
            </button>
          </SettingsRow>
        </SettingsCard>
        {restartError && (
          <p role="alert" className="text-xs text-destructive">
            {restartError}
          </p>
        )}
      </SettingsSection>
      {families.map(({ id: family, label, Logo }) => {
        const profiles = profilesFor(family)
        const globalId =
          preferences.globalDefaults[family] ?? profiles.find((profile) => profile.builtIn)?.id
        const workspaceId = activeWorkspaceId
          ? (preferences.workspaceOverrides[activeWorkspaceId]?.[family] ?? '')
          : ''
        const profileOptions = profiles.map((profile) => ({
          value: profile.id,
          label: profile.name
        }))
        return (
          <SettingsSection
            key={family}
            title={
              <>
                <Logo />
                {label}
              </>
            }
          >
            <SettingsCard>
              <SettingsRow label="Global default">
                <SettingsSelect
                  value={globalId ?? ''}
                  options={profileOptions}
                  onChange={(value) => void setGlobalLaunchProfile(family, value)}
                  ariaLabel={`Global default profile for ${label}`}
                  testId={`global-${family}`}
                />
              </SettingsRow>
              {activeWorkspaceId && (
                <SettingsRow label="Workspace override" description="Empty uses the global default">
                  <SettingsSelect
                    value={workspaceId || USE_GLOBAL}
                    options={[
                      { value: USE_GLOBAL, label: 'Use global default' },
                      ...profileOptions
                    ]}
                    onChange={(value) =>
                      void setWorkspaceDefault(
                        activeWorkspaceId,
                        family,
                        value === USE_GLOBAL ? null : value
                      )
                    }
                    ariaLabel={`Workspace override for ${label}`}
                    testId={`workspace-${family}`}
                  />
                </SettingsRow>
              )}
              {profiles.map((profile) => (
                <div key={profile.id} className="settings-row" data-launch-profile={profile.id}>
                  <div className="min-w-0">
                    <div className="settings-row-title truncate">{profile.name}</div>
                    <div className="settings-row-description font-mono truncate">
                      {profile.command.join(' ')}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                    {profile.builtIn ? (
                      <span className="badge bg-surface-200 text-text-tertiary">Built in</span>
                    ) : (
                      <>
                        <button className="btn-secondary" onClick={() => setEditing(profile)}>
                          Edit
                        </button>
                        <button
                          className="btn-icon btn-icon-md btn-icon--danger"
                          onClick={() => void deleteLaunchProfile(profile.id)}
                          title="Delete profile"
                          aria-label={`Delete profile ${profile.name}`}
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              <button
                className="settings-row-action"
                onClick={() =>
                  setEditing({
                    id: crypto.randomUUID(),
                    name: `Custom ${label}`,
                    family,
                    command: [...(profiles.find((profile) => profile.builtIn)?.command ?? [])],
                    additionalArgs: []
                  })
                }
              >
                <PlusIcon className="w-4 h-4" /> Add profile
              </button>
            </SettingsCard>
            {editing?.family === family && (
              <ProfileEditor profile={editing} onDone={() => setEditing(null)} />
            )}
          </SettingsSection>
        )
      })}
    </SettingsPage>
  )
}
