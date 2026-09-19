import { useCallback, useEffect, useState } from 'react'
import type { LegacyAgentCandidate } from '../../../../shared/session-migration'
import {
  useLaunchProfileStore,
  loadLaunchProfiles,
  profilesFor,
  selectedLaunchProfile
} from '../../store/launch-profile-store'
import { applySessionMigration, restartConversationService } from '../../lib/session-migration'
import { SettingsSelect } from '../settings/primitives'
import { TerminalHeader } from './TerminalHeader'

/** A metadata-only tab. Mounting this component never touches the source process. */
export function LegacyAgentMigrationPanel({
  sessionId,
  legacyId
}: {
  sessionId: string
  legacyId: string
}): React.JSX.Element {
  const [candidate, setCandidate] = useState<LegacyAgentCandidate>()
  const [profileId, setProfileId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const preferences = useLaunchProfileStore((state) => state.preferences)
  const profiles = candidate ? profilesFor(candidate.provider) : []
  const selected = profiles.find((profile) => profile.id === profileId)
  void preferences // Subscribe to profile changes made in Settings → Agents.

  const inspect = useCallback(async () => {
    setError('')
    try {
      await loadLaunchProfiles()
      const next = await window.electronAPI.sessionMigration.inspect(legacyId)
      setCandidate(next)
      // A removed profile must not silently fall back to a different command.
      setProfileId(
        next.launchProfileId ?? selectedLaunchProfile(next.provider, next.workspaceId ?? null).id
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [legacyId])

  useEffect(() => {
    void inspect()
  }, [inspect])

  const migrate = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const result = await window.electronAPI.sessionMigration.migrate(legacyId, selected.id)
      if (result) applySessionMigration(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const restart = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (await restartConversationService()) await inspect()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-surface-0" data-testid="legacy-agent-migration">
      <TerminalHeader sessionId={sessionId} />
      <div className="conversation-empty overflow-auto">
        <h2>Move this agent to a conversation</h2>
        <p>This tab is saved in its original position. Its terminal is not attached.</p>
        {candidate && (
          <>
            <p>
              {candidate.provider} · {candidate.live ? 'Process still running' : 'Process stopped'}
            </p>
            <span className="conversation-folder">{candidate.cwd}</span>
            <SettingsSelect
              ariaLabel="Migration launch profile"
              testId="migration-launch-profile"
              value={selected ? profileId : ''}
              options={profiles.map((profile) => ({
                value: profile.id,
                label: profile.name,
                hint: profile.command.join(' ')
              }))}
              onChange={setProfileId}
              disabled={busy}
            />
            {!selected && (
              <p role="alert">
                The saved launch profile is missing. Choose a profile from Settings → Agents.
              </p>
            )}
            <p>
              {candidate.resumeSessionId
                ? `Native context can resume using saved session ${candidate.resumeSessionId}.`
                : 'No native resume ID was saved. This starts fresh; Clave will not guess a history file.'}
            </p>
            <p>Earlier native transcript is not imported. Old prompts are never replayed.</p>
            {candidate.live && (
              <p>
                Confirming the move interrupts the running process. You will be asked before it
                stops.
              </p>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="conversation-actions">
          <button
            className="btn-primary"
            disabled={busy || !selected}
            onClick={() => void migrate()}
          >
            {busy ? 'Working…' : 'Move to conversation'}
          </button>
          {error && (
            <>
              <button className="btn-secondary" disabled={busy} onClick={() => void inspect()}>
                Try again
              </button>
              <button className="btn-secondary" disabled={busy} onClick={() => void restart()}>
                Restart background service
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
