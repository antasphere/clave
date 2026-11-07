import { clearLaunchNotice, useLaunchNoticeStore } from '../../store/launch-notice-store'

/** Why a launch did not start, over the stage: a server workspace whose
 *  server is offline, or a start its server refused (#241). */
export function LaunchNotice(): React.JSX.Element | null {
  const message = useLaunchNoticeStore((s) => s.message)
  if (!message) return null
  return (
    <div className="stage-notice">
      <div className="settings-callout" data-tone="danger" role="alert" data-testid="launch-notice">
        <p className="settings-callout-title">The session did not start</p>
        <p className="settings-callout-text">{message}</p>
        <div className="settings-callout-actions">
          <button type="button" className="btn-secondary" onClick={clearLaunchNotice}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
