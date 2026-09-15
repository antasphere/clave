import { useEffect, useState } from 'react'
import {
  ArrowPathIcon,
  ArrowDownTrayIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  DocumentTextIcon,
  ArrowTopRightOnSquareIcon
} from '@heroicons/react/24/outline'
import { useUpdaterStore } from '../../store/updater-store'
import { SettingsPage, SettingsSection, SettingsCard, SettingsRow } from './primitives'
import { ClaveMark } from '../ui/ClaveMark'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatChecked(at: number | null): string {
  if (!at) return 'Never'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  const date = new Date(at)
  const today = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`
}

/**
 * Software Update — the pane that makes the updater something a user can
 * operate instead of something that happens to them.
 *
 * Everything here is a read of main-process state plus three verbs: check,
 * download, install. It exists because the only previous affordance was a
 * banner that appeared for a moment in the sidebar; miss it, dismiss it, or
 * have the check fail quietly, and there was no surface left that even
 * admitted an update existed.
 */
export function UpdatesTab(): React.JSX.Element {
  const {
    supported,
    phase,
    currentVersion,
    availableVersion,
    progress,
    errorMessage,
    checkErrorMessage,
    lastCheckedAt,
    check,
    startDownload,
    cancelDownload
  } = useUpdaterStore()
  const [checking, setChecking] = useState(false)
  // Re-render so "2 min ago" keeps up while the pane is open.
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const handleCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await check()
    } finally {
      setChecking(false)
    }
  }

  const busy = checking || phase === 'checking'
  const upToDate = supported && !availableVersion && phase !== 'error'

  return (
    <SettingsPage
      title="Software Update"
      description="Clave updates itself from its GitHub releases. Check, download and install from here."
    >
      <SettingsSection title="Installed version">
        <SettingsCard>
          <div className="settings-row">
            <div className="flex items-center gap-3 min-w-0">
              <ClaveMark className="w-10 h-10 flex-shrink-0" />
              <div className="min-w-0">
                <p className="settings-row-title">Clave {currentVersion}</p>
                <p className="settings-row-description">
                  {!supported
                    ? 'Updates are disabled in development builds'
                    : phase === 'downloaded'
                      ? `Version ${availableVersion} is ready to install`
                      : phase === 'downloading'
                        ? `Downloading version ${availableVersion}…`
                        : availableVersion
                          ? `Version ${availableVersion} is available`
                          : upToDate
                            ? 'Clave is up to date'
                            : 'Checking for updates…'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {phase === 'downloading' ? (
                <button onClick={cancelDownload} className="btn-secondary">
                  Cancel
                </button>
              ) : phase === 'downloaded' ? (
                <button onClick={() => window.electronAPI?.installUpdate()} className="btn-primary">
                  Restart & Install
                </button>
              ) : availableVersion ? (
                <button onClick={() => startDownload()} className="btn-primary">
                  <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                  Download & Install
                </button>
              ) : (
                <button
                  onClick={handleCheck}
                  disabled={!supported || busy}
                  className="btn-secondary"
                >
                  <ArrowPathIcon className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
                  {busy ? 'Checking…' : 'Check for Updates'}
                </button>
              )}
            </div>
          </div>

          {/* Live progress, so a 220 MB download is not a frozen dialog. */}
          {phase === 'downloading' && (
            <div className="settings-row flex-col items-stretch gap-2">
              <div className="usage-bar">
                <div
                  className="usage-meter-fill usage-meter-fill--normal"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <p className="settings-row-description">
                {progress.total > 0
                  ? `${formatBytes(progress.transferred)} of ${formatBytes(progress.total)}`
                  : 'Starting download…'}
                {progress.bytesPerSecond > 0 && ` · ${formatSpeed(progress.bytesPerSecond)}`}
                {` · ${Math.round(progress.percent)}%`}
              </p>
            </div>
          )}

          <SettingsRow label="Last checked" description={formatChecked(lastCheckedAt)}>
            {supported && availableVersion && (
              <button onClick={handleCheck} disabled={busy} className="btn-secondary">
                <ArrowPathIcon className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
                Check Again
              </button>
            )}
          </SettingsRow>

          {upToDate && phase !== 'checking' && lastCheckedAt !== null && (
            <div className="settings-row">
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircleIcon className="w-4 h-4 flex-shrink-0 text-accent" />
                <p className="settings-row-description">
                  Clave {currentVersion} is the latest version.
                </p>
              </div>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* A check that failed is not an emergency, but it must be visible: it is
          the difference between "you are up to date" and "we could not find
          out". It used to be swallowed entirely. */}
      {checkErrorMessage && phase !== 'error' && (
        <SettingsSection title="Last check failed">
          <SettingsCard>
            <div className="settings-row">
              <div className="flex items-start gap-2 min-w-0">
                <ExclamationTriangleIcon className="w-4 h-4 flex-shrink-0 mt-0.5 text-warning" />
                <div className="min-w-0">
                  <p className="settings-row-title">Could not check for updates</p>
                  <p className="settings-row-description break-words">{checkErrorMessage}</p>
                </div>
              </div>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {phase === 'error' && (
        <SettingsSection title="Update failed">
          <SettingsCard>
            <div className="settings-row">
              <div className="flex items-start gap-2 min-w-0">
                <ExclamationTriangleIcon className="w-4 h-4 flex-shrink-0 mt-0.5 text-destructive" />
                <div className="min-w-0">
                  <p className="settings-row-title">The download did not complete</p>
                  <p className="settings-row-description break-words">
                    {errorMessage || 'An unexpected error occurred'}
                  </p>
                </div>
              </div>
              <button onClick={() => startDownload('retry')} className="btn-primary">
                Try Again
              </button>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection
        title="If an update will not install"
        description="Auto-update is Clave's only distribution channel, so these two are the way out when it cannot deliver: install the release by hand, and send us the log that says why."
      >
        <SettingsCard>
          <SettingsRow
            label="Download from GitHub"
            description="Install the latest release manually as a .dmg"
          >
            <button
              onClick={() => window.electronAPI?.openReleasesPage()}
              className="btn-secondary"
            >
              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
              Open Releases
            </button>
          </SettingsRow>
          <SettingsRow
            label="Updater log"
            description="Every check and download, with the reason a failure failed"
          >
            <button onClick={() => window.electronAPI?.openUpdaterLog()} className="btn-secondary">
              <DocumentTextIcon className="w-3.5 h-3.5" />
              Open Log
            </button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  )
}
