import { useEffect } from 'react'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { initArtefacts, useArtefactStore } from '../../store/artefact-store'
import { useFleetStore } from '../../store/fleet-store'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

/**
 * Settings → Software Update → Slideless (PRDCT-4262, PRDCT-4474): the copy
 * of the Slideless command line each machine that runs sessions keeps to show
 * their HTML artefacts, one row per machine (this Mac, then each connected
 * server by its name), with its version and the button that installs the
 * latest release on that machine. Each machine installs its own at the
 * first start that finds none; this is where a person sees it and fixes a
 * failed install.
 */
export function SlidelessSection(): React.JSX.Element {
  useEffect(() => initArtefacts(), [])
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const machines = [
    { owner: 'local', name: 'This Mac' },
    ...connections
      .filter((c) => c.enabled && statuses[c.id]?.state === 'connected')
      .map((c) => ({ owner: c.id, name: c.name }))
  ]
  return (
    <SettingsSection
      title="Slideless"
      description="The command line that shows HTML artefacts beside your sessions. Each machine that runs sessions keeps its own copy."
    >
      <SettingsCard>
        {machines.map((machine) => (
          <SlidelessRow key={machine.owner} owner={machine.owner} name={machine.name} />
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}

function SlidelessRow({ owner, name }: { owner: string; name: string }): React.JSX.Element {
  const state = useArtefactStore((s) => s.slideless[owner])
  const install = useArtefactStore((s) => s.install)
  useEffect(() => useArtefactStore.getState().readSlideless(owner), [owner])
  const phase = state?.phase ?? 'missing'
  // This Mac shows its own pages plain without Slideless; a server's pages
  // show only through it, so the missing line says so.
  const own = owner === 'local'
  const line =
    phase === 'ready'
      ? state?.override
        ? 'Running the command line named by CLAVE_SLIDELESS_CLI.'
        : `Shows HTML artefacts beside the sessions of ${own ? 'this Mac' : 'this server'}, reloads them on every edit and keeps a version each turn. No account.`
      : phase === 'installing'
        ? 'Installing the latest release.'
        : phase === 'error'
          ? 'The last install failed.'
          : own
            ? 'Not installed: HTML artefacts show without reload or versions until it is.'
            : 'Not installed: the HTML artefacts of this server do not show until it is.'
  return (
    <SettingsRow
      label={`${name} · Slideless${state?.version && !state.override ? ` ${state.version}` : ''}`}
      description={
        <span data-slideless-status={phase} data-slideless-owner={owner}>
          {line}
          {state?.error && phase === 'error' && (
            <span className="status-text block break-words" data-status="error">
              {state.error}
            </span>
          )}
        </span>
      }
    >
      {!state?.override && (
        <button
          onClick={() => void install(owner).catch(() => {})}
          disabled={phase === 'installing'}
          className="btn-secondary"
          data-slideless-install
          data-slideless-owner={owner}
        >
          <ArrowDownTrayIcon className="w-3.5 h-3.5" />
          {phase === 'installing'
            ? 'Installing…'
            : phase === 'ready'
              ? 'Install latest'
              : phase === 'error'
                ? 'Try again'
                : 'Install'}
        </button>
      )}
    </SettingsRow>
  )
}
