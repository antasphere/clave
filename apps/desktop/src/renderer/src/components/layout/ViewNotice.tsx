import { useMemo } from 'react'
import { BrandField } from '../ui/BrandField'
import { useUserStore } from '../../store/user-store'
import { seedFromString } from '../../lib/brand-field'

export type ViewNoticeState = 'checking' | 'starting' | 'down' | 'loading'

export interface ViewNoticeProps {
  state: ViewNoticeState
  /** The page's name and address, as the header shows them. */
  title: string
  url: string
  /** Milliseconds since the start began (starting only). */
  elapsedMs?: number
  /** Past the patience window: the start is still running, and the reader
   *  gets the terminal and a restart beside the clock. */
  patient?: boolean
  /** The serving command — shown as a chip whenever there is one. */
  command?: string | null
  /** Why the last start could not even spawn. */
  error?: string | null
  /** The button's verb: a first start, or a restart of one already asked for. */
  startLabel?: string
  onStart?: () => void
  onShowTerminal?: () => void
  onRetry?: () => void
}

/** "1:05" for 65 s — the elapsed a starting notice carries. */
const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const LINES: Record<ViewNoticeState, string> = {
  checking: 'Checking the server…',
  starting: 'Starting the server…',
  down: 'The server is not responding',
  loading: 'Loading the page…'
}

/**
 * What a web view shows when it has no page to show. The ground is the user's
 * own Antasphere field — the sidebar foot's material — held far off the
 * surface (a quiet, grained wash, not a picture) and seeded from the page's
 * address, so every board carries a field of its own. Over it, the popover
 * material: the same card the workspace switcher opens in, with the status
 * row, one line saying what is happening, the clock while a start runs, the
 * thin sweep the panel bars use for "started, count unknown", the serving
 * command as a chip, and the actions as proper buttons. The states are the
 * pane's (`WebViewPane`): checking on mount, starting, down, and loading once
 * the server answers but the page has not painted yet.
 */
export function ViewNotice({
  state,
  title,
  url,
  elapsedMs = 0,
  patient = false,
  command,
  error,
  startLabel = 'Start',
  onStart,
  onShowTerminal,
  onRetry
}: ViewNoticeProps): React.JSX.Element {
  const palette = useUserStore((s) => s.avatarField)
  const seed = useMemo(() => seedFromString(url), [url])
  const line =
    state === 'starting' && patient ? 'Still starting — the command is running' : LINES[state]
  const busy = state === 'starting' || state === 'loading' || state === 'checking'
  const showActions = state === 'down' || patient

  return (
    <div className="view-notice" data-testid="view-notice" data-state={state}>
      {/* Held well off the surface and grained: the field is met as texture
          first and colour second, the way the website's page field sits under
          a page of reading. */}
      <BrandField
        palette={palette}
        seed={seed}
        groundLift={0.08}
        grainAlpha={0.28}
        className="view-notice-field"
      />
      <div className="view-notice-card menu-surface menu-pop-mount">
        <div className="view-notice-head">
          <span className="view-notice-dot" data-state={state} />
          <span className="view-notice-title">{title}</span>
          <span className="view-notice-url">{url}</span>
        </div>
        <div className="view-notice-line">
          <span data-testid="view-notice-text">{line}</span>
          {state === 'starting' && (
            <span className="view-notice-elapsed" data-testid="view-notice-elapsed">
              {formatElapsed(elapsedMs)}
            </span>
          )}
        </div>
        {busy && (
          <div className="panel-progress-track is-indeterminate" aria-hidden="true">
            <span className="panel-progress-fill" />
          </div>
        )}
        {command && (
          <span className="view-notice-command" title={command}>
            {command}
          </span>
        )}
        {error && (
          <div className="view-notice-error" data-testid="view-start-error">
            Could not start: {error}
          </div>
        )}
        {showActions && (
          <div className="view-notice-actions">
            {onStart && (
              <button onClick={onStart} className="btn-primary" data-testid="view-start">
                {startLabel}
              </button>
            )}
            {onShowTerminal && (
              <button
                onClick={onShowTerminal}
                className="btn-secondary"
                data-testid="view-show-terminal"
              >
                Show terminal
              </button>
            )}
            {state === 'down' && onRetry && (
              <button onClick={onRetry} className="btn-secondary">
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
