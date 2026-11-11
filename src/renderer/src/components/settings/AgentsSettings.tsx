import { useState } from 'react'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
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
import type {
  LaunchProfile,
  LaunchProfilePreferences,
  LauncherFamily,
  PiThinkingLevel
} from '../../../../shared/agent-launch'
import { ClaudeLogo, AntigravityLogo, CodexLogo, PiLogo } from '../icons/cli-logos'
import {
  SettingsCallout,
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
          <div key={index} className="settings-row-controls">
            <input
              className="input-compact font-mono"
              value={token}
              onChange={(event) => replace(index, event.target.value)}
              aria-label={`${label} token ${index + 1}`}
            />
            <button
              className="btn-icon btn-icon-sm"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              title="Move up"
              aria-label="Move up"
            >
              <ArrowUpIcon className="w-3.5 h-3.5" />
            </button>
            <button
              className="btn-icon btn-icon-sm"
              onClick={() => move(index, 1)}
              disabled={index === tokens.length - 1}
              title="Move down"
              aria-label="Move down"
            >
              <ArrowDownIcon className="w-3.5 h-3.5" />
            </button>
            <button
              className="btn-icon btn-icon-sm btn-icon--danger"
              onClick={() => onChange(tokens.filter((_, i) => i !== index))}
              title="Remove token"
              aria-label="Remove token"
            >
              <TrashIcon className="w-3.5 h-3.5" />
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
  onSave,
  onDone
}: {
  profile: LaunchProfile
  onSave: (profile: LaunchProfile) => Promise<void>
  onDone: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(profile)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    try {
      await onSave({
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
    <SettingsCard data-launch-profile-editor>
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
      {error && <SettingsCallout inset tone="danger" text={error} />}
      <div className="settings-row">
        {/* ml-auto, not justify-end: the row's own space-between is unlayered
            and beats the utility (field guide, rule 1). */}
        <div className="settings-row-controls ml-auto">
          <button className="btn-secondary" onClick={onDone}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void save()}>
            Save profile
          </button>
        </div>
      </div>
    </SettingsCard>
  )
}

/**
 * Where a page's launch profiles come from and where its edits go: this
 * Mac's store, or a connected server's settings read and written over its
 * connection (the machine picker of the settings sidebar). The page is the
 * same either way; the source decides the machine.
 */
export interface LaunchProfileSource {
  preferences: LaunchProfilePreferences
  profilesFor: (family: LauncherFamily) => LaunchProfile[]
  upsert: (profile: LaunchProfile) => Promise<void>
  remove: (profileId: string) => Promise<void>
  setGlobal: (family: LauncherFamily, profileId: string | null) => Promise<void>
  /** This Mac's active workspace, whose override row the page draws; a
   *  server's profiles have no workspace row here. */
  workspaceId: string | null
  setWorkspace?: (
    workspaceId: string,
    family: LauncherFamily,
    profileId: string | null
  ) => Promise<void>
}

/** This Mac's profiles, from the launch profile store. */
function useLocalLaunchProfileSource(): LaunchProfileSource {
  const preferences = useLaunchProfileStore((state) => state.preferences)
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  return {
    preferences,
    profilesFor,
    upsert: saveLaunchProfile,
    remove: deleteLaunchProfile,
    setGlobal: setGlobalLaunchProfile,
    workspaceId: activeWorkspaceId,
    setWorkspace: async (workspaceId, family, profileId) => {
      await setWorkspaceLaunchProfile(workspaceId, family, profileId)
      const setup = getLastAgentSetup(workspaceId)
      const setupFamily = setup.kind === 'claude-agents' ? 'claude' : setup.kind
      if (setupFamily !== family) return
      rememberAgentSetup(workspaceId, {
        ...setup,
        launchProfileId: profileId ?? undefined
      })
    }
  }
}

/**
 * One family's launch profiles: the global default, this workspace's
 * override, the profiles themselves and the editor. Rendered as its own
 * section on a server's page, and inside each harness's Advanced fold on
 * Settings → Harnesses (PRDCT-4424).
 */
export function LaunchProfilesFamily({
  family,
  label,
  source: given
}: {
  family: LauncherFamily
  label: string
  /** Where the profiles come from; this Mac's store when absent. */
  source?: LaunchProfileSource
}): React.JSX.Element {
  const local = useLocalLaunchProfileSource()
  const source = given ?? local
  const { preferences, workspaceId: activeWorkspaceId } = source
  const [editing, setEditing] = useState<LaunchProfile | null>(null)
  const setWorkspaceDefault = async (
    workspaceId: string,
    profileId: string | null
  ): Promise<void> => {
    await source.setWorkspace?.(workspaceId, family, profileId)
  }
  const profiles = source.profilesFor(family)
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
    <>
      <SettingsCard data-launch-profiles={family}>
        <SettingsRow label="Global default">
          <SettingsSelect
            value={globalId ?? ''}
            options={profileOptions}
            onChange={(value) => void source.setGlobal(family, value)}
            ariaLabel={`Global default profile for ${label}`}
            testId={`global-${family}`}
          />
        </SettingsRow>
        {activeWorkspaceId && source.setWorkspace && (
          <SettingsRow label="This workspace" description="Overrides the global default here only">
            <SettingsSelect
              value={workspaceId || USE_GLOBAL}
              options={[{ value: USE_GLOBAL, label: 'Use global default' }, ...profileOptions]}
              onChange={(value) =>
                void setWorkspaceDefault(activeWorkspaceId, value === USE_GLOBAL ? null : value)
              }
              ariaLabel={`Workspace override for ${label}`}
              testId={`workspace-${family}`}
            />
          </SettingsRow>
        )}
        {profiles
          .filter((profile) => !profile.sourceProfileId)
          .map((profile) => (
            <div key={profile.id} className="settings-row" data-launch-profile={profile.id}>
              <div className="min-w-0">
                <div className="settings-row-title truncate">{profile.name}</div>
                <div className="settings-row-description font-mono truncate">
                  {profile.command.join(' ')}
                </div>
              </div>
              <div className="settings-row-controls">
                {profile.builtIn ? (
                  <span className="badge badge-muted">Built in</span>
                ) : (
                  <>
                    <button className="btn-secondary" onClick={() => setEditing(profile)}>
                      Edit
                    </button>
                    <button
                      className="btn-icon btn-icon-sm btn-icon--danger"
                      onClick={() => void source.remove(profile.id)}
                      title="Delete profile"
                      aria-label={`Delete profile ${profile.name}`}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
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
              command: [family === 'antigravity' ? 'agy' : family],
              additionalArgs: []
            })
          }
        >
          <PlusIcon className="w-4 h-4" /> Add profile
        </button>
      </SettingsCard>
      {editing && (
        <ProfileEditor profile={editing} onSave={source.upsert} onDone={() => setEditing(null)} />
      )}
    </>
  )
}

/**
 * The launch profiles of every family, one section each: a server's
 * Harnesses page (this Mac's own is Settings → Harnesses, whose harness rows
 * carry the same blocks in their Advanced folds).
 */
export function AgentsSettings(props: {
  source?: LaunchProfileSource
  title?: string
  description?: React.ReactNode
}): React.JSX.Element {
  const local = useLocalLaunchProfileSource()
  const source = props.source ?? local
  return (
    <SettingsPage
      title={props.title ?? 'Harnesses'}
      description={
        props.description ??
        'The command each harness launches with. Keep passwords and API keys out of it: profiles are stored in plain text.'
      }
      testId="agents"
    >
      {FAMILIES.map(({ id: family, label, Logo }) => (
        <SettingsSection
          key={family}
          title={
            <>
              <Logo />
              {label}
            </>
          }
        >
          <LaunchProfilesFamily family={family} label={label} source={source} />
        </SettingsSection>
      ))}
    </SettingsPage>
  )
}
