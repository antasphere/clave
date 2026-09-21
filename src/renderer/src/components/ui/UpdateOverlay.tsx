import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useUpdaterStore } from '../../store/updater-store'
import { ClaveMark } from './ClaveMark'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
}

export function UpdateOverlay() {
  const phase = useUpdaterStore((s) => s.phase)
  const version = useUpdaterStore((s) => s.availableVersion)
  const progress = useUpdaterStore((s) => s.progress)
  const errorMessage = useUpdaterStore((s) => s.errorMessage)
  const errorAcknowledged = useUpdaterStore((s) => s.errorAcknowledged)
  const startDownload = useUpdaterStore((s) => s.startDownload)
  const cancelDownload = useUpdaterStore((s) => s.cancelDownload)
  const acknowledgeError = useUpdaterStore((s) => s.acknowledgeError)
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Progress, completion and failure all arrive on the single `updater:state`
  // channel the shell subscribes to — this component just renders the phase.

  // Auto-restart when downloaded
  useEffect(() => {
    if (phase === 'downloaded') {
      restartTimerRef.current = setTimeout(() => {
        window.electronAPI?.installUpdate()
      }, 1500)
    }
    return () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current)
    }
  }, [phase])

  const handleCancel = () => cancelDownload()

  const handleRetry = () => {
    // 'retry' tells the main process to drop the differential download and
    // fetch the whole file. Retrying the identical request is what made a
    // failed update unescapable — see downloadStrategy() in auto-updater.ts.
    startDownload('retry')
  }

  const handleOpenReleases = (): void => {
    void window.electronAPI?.openReleasesPage()
  }

  const handleOpenLog = (): void => {
    window.electronAPI?.openUpdaterLog()
  }

  const visible =
    phase === 'downloading' || phase === 'downloaded' || (phase === 'error' && !errorAcknowledged)

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-0/80 backdrop-blur-xl"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }}
            className="flex flex-col items-center gap-8 w-80"
          >
            {/* Logo */}
            <motion.div
              animate={
                phase === 'downloaded'
                  ? { scale: [1, 1.05, 1], opacity: [1, 0.8, 1] }
                  : undefined
              }
              transition={
                phase === 'downloaded'
                  ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }
                  : undefined
              }
            >
              <ClaveMark className="w-16 h-16" />
            </motion.div>

            {/* Status text */}
            <div className="text-center">
              {phase === 'downloading' && (
                <>
                  <p className="text-[15px] font-medium text-text-primary">
                    Updating to {version ? `v${version}` : 'new version'}
                  </p>
                  <p className="text-control text-text-tertiary mt-1">
                    {progress.total > 0
                      ? `${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`
                      : 'Starting download...'}
                    {progress.bytesPerSecond > 0 && (
                      <span className="ml-2">{formatSpeed(progress.bytesPerSecond)}</span>
                    )}
                  </p>
                </>
              )}
              {phase === 'downloaded' && (
                <>
                  <p className="text-[15px] font-medium text-text-primary">Restarting...</p>
                  <p className="text-control text-text-tertiary mt-1">
                    {version ? `v${version}` : 'Update'} is ready to go
                  </p>
                </>
              )}
              {phase === 'error' && (
                <>
                  <p className="text-[15px] font-medium text-text-primary">Update failed</p>
                  <p className="text-control text-text-tertiary mt-1 max-w-[280px]">
                    {errorMessage || 'An unexpected error occurred'}
                  </p>
                  {/* Auto-update is the only distribution channel — no App Store,
                      no package manager. Without these two links a user whose
                      update keeps failing has no way to get the new version and
                      nothing to send us about why. */}
                  <div className="flex items-center justify-center gap-3 mt-3 text-[12px]">
                    <button
                      onClick={handleOpenReleases}
                      className="text-text-tertiary hover:text-text-primary underline underline-offset-2 transition-colors"
                    >
                      Download from GitHub
                    </button>
                    <span className="text-text-tertiary">·</span>
                    <button
                      onClick={handleOpenLog}
                      className="text-text-tertiary hover:text-text-primary underline underline-offset-2 transition-colors"
                    >
                      Open log
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Progress bar */}
            {(phase === 'downloading' || phase === 'downloaded') && (
              <div className="w-full">
                <div className="h-1.5 rounded-full bg-surface-200 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-accent"
                    initial={{ width: 0 }}
                    animate={{ width: `${phase === 'downloaded' ? 100 : progress.percent}%` }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                  />
                </div>
                <p className="text-[12px] text-text-tertiary mt-2 text-center">
                  {phase === 'downloaded' ? '100' : Math.round(progress.percent)}%
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3">
              {phase === 'downloading' && (
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 text-control font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-200 transition-colors"
                >
                  Cancel
                </button>
              )}
              {phase === 'error' && (
                <>
                  <button
                    onClick={acknowledgeError}
                    className="px-4 py-2 text-control font-medium text-text-secondary hover:text-text-primary rounded-lg border border-border hover:bg-surface-200 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleRetry}
                    className="px-4 py-2 text-control font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition-colors"
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
