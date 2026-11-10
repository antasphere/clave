import { useEffect } from 'react'
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline'
import { initSlideless, useSlidelessStore } from '../../store/slideless-store'
import { SettingsCard, SettingsRow, SettingsSection } from './primitives'

/**
 * Settings → Software Update → Slideless (PRDCT-4262): the copy of the
 * Slideless command line Clave runs to show HTML artefacts, its version, and
 * the one button that installs the latest release. Clave installs it on its
 * own at the first launch that finds none; this is where a person sees it and
 * fixes a failed install.
 */
export function SlidelessSection(): React.JSX.Element {
  useEffect(() => initSlideless(), [])
  const state = useSlidelessStore((s) => s.state)
  const install = useSlidelessStore((s) => s.install)
  const phase = state?.phase ?? 'missing'
  const line =
    phase === 'ready'
      ? state?.override
        ? 'Running the command line named by CLAVE_SLIDELESS_CLI.'
        : 'Clave’s own copy: it shows HTML artefacts beside your sessions, reloads them on every edit and keeps a version each turn. No account.'
      : phase === 'installing'
        ? 'Installing…'
        : phase === 'error'
          ? 'The last install failed.'
          : 'Not installed: HTML artefacts show without reload or versions until it is.'
  return (
    <SettingsSection
      title="Slideless"
      description="The command line that shows HTML artefacts in Clave's side panel, installed and kept by Clave."
    >
      <SettingsCard>
        <SettingsRow
          label={`Slideless${state?.version && !state.override ? ` ${state.version}` : ''}`}
          description={
            <span data-slideless-status={phase}>
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
              onClick={() => void install()}
              disabled={phase === 'installing'}
              className="btn-secondary"
              data-slideless-install
            >
              <ArrowDownTrayIcon className="w-3.5 h-3.5" />
              {phase === 'installing'
                ? 'Installing…'
                : phase === 'ready'
                  ? 'Install latest'
                  : 'Install'}
            </button>
          )}
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}
