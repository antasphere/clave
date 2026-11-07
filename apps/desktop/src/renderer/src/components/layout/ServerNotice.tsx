import { useEffect } from 'react'
import { bindServerNotices, useServerNoticeStore } from '../../store/server-notice-store'

/** The server's refusal, over the stage where the sessions would be: a
 *  window attached to a server that runs no sessions reads why, instead of
 *  an empty list or a chat that never mounts. */
export function ServerNotice(): React.JSX.Element | null {
  useEffect(() => bindServerNotices(), [])
  const message = useServerNoticeStore((s) => s.message)
  const capability = useServerNoticeStore((s) => s.capability)
  if (!message) return null
  return (
    <div className="stage-notice">
      <div className="settings-callout" data-tone="danger" role="alert" data-testid="server-notice">
        <p className="settings-callout-title">This server runs no {capability ?? 'sessions'}</p>
        <p className="settings-callout-text">{message}</p>
      </div>
    </div>
  )
}
