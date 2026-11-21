import { useEffect, useRef } from 'react'
import {
  ArrowTopRightOnSquareIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { Scrub, VoiceFigure } from '../../../../../plugins/chat-view/src/lab/VoiceCard'
import { macVoiceLine } from '../../../../../plugins/chat-view/src/lab/voice-card'
import { fallbackLine } from '../../../../../plugins/chat-view/src/lab/spoken'
import { useSessionStore } from '../../store/session-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { useShortcutLabel } from '../../store/keymap-store'
import { useUpdatesStore } from '../../store/updates-store'
import { setActiveWorkspace } from '../../lib/workspace-actions'
import { setCardHover } from '../../lib/updates-voice'
import { blockLabel, updateName } from '../../lib/updates'

/* The updates card (PRDCT-4832), under the chip, right-aligned to it: the
   reading in progress whose page is off screen, then the waiting updates,
   oldest first. Its own positioned surface, never a Radix popover: it never
   takes the keyboard focus when it opens or changes. Escape closes it while
   the focus is inside it; a pointer down outside it closes it; an announced
   banner closes itself (the announcer's timer, `lib/updates-voice.ts`). */

/** Go to a tab from anywhere: its workspace first when it is another one,
 *  then the tab, over Settings or a group view. */
function openTab(sessionId: string): void {
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session) return
  const active = useWorkspaceStore.getState().activeWorkspaceId
  if (session.workspaceId && active && session.workspaceId !== active)
    void setActiveWorkspace(session.workspaceId)
  useSessionStore.getState().selectSession(sessionId, false)
}

export function UpdateCard({
  mode,
  anchor
}: {
  mode: 'banner' | 'pinned'
  anchor: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const updates = useUpdatesStore((s) => s.updates)
  const current = useUpdatesStore((s) => s.current)
  const sessions = useSessionStore((s) => s.sessions)
  const groups = useSessionStore((s) => s.groups)
  const shortcut = useShortcutLabel('playUpdate')
  const card = useRef<HTMLDivElement>(null)
  const offScreen = current && !current.onScreen ? current : null

  // A pointer down outside the card (and outside its chip) closes it.
  useEffect(() => {
    const away = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && anchor.current?.contains(target)) return
      useUpdatesStore.getState().closeCard()
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [anchor])
  useEffect(() => () => setCardHover(false), [])

  const reading = offScreen?.reading
  const voiceState = !reading
    ? 'idle'
    : reading.state === 'preparing'
      ? reading.step === 'creating'
        ? 'creating'
        : 'rewriting'
      : reading.state
  const names = offScreen ? updateName(offScreen.sessionId, sessions, groups) : null

  return (
    <div
      ref={card}
      className="menu-surface menu-pop-mount update-card"
      data-testid="update-card"
      data-open={mode}
      data-voice-state={voiceState}
      role="region"
      aria-label="Updates"
      onPointerEnter={() => setCardHover(true)}
      onPointerLeave={() => setCardHover(false)}
      // Touched, a banner stays: the person is reading it.
      onPointerDown={() => {
        if (useUpdatesStore.getState().cardOpen === 'banner')
          useUpdatesStore.getState().openCard('pinned')
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        useUpdatesStore.getState().closeCard()
      }}
    >
      <div className="update-card-head">
        <VoiceFigure />
        <span className="update-card-eyebrow">Updates</span>
      </div>

      {offScreen && reading && names && (
        <section className="update-card-current" aria-label="Reading">
          <p className="update-card-name">{names.group ?? names.tab}</p>
          <p className="update-card-detail">
            {names.group ? `${names.tab} · ` : ''}
            {offScreen.title}
          </p>
          <div className="update-card-controls">
            <button
              type="button"
              className="btn-icon btn-icon-md"
              data-testid="update-card-play"
              aria-label={reading.state === 'playing' ? 'Pause' : 'Play'}
              title={reading.state === 'playing' ? 'Pause' : 'Play'}
              disabled={reading.state === 'preparing'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void useUpdatesStore.getState().toggle()}
            >
              {reading.state === 'playing' ? (
                <PauseIcon className="w-4 h-4" />
              ) : (
                <PlayIcon className="w-4 h-4" />
              )}
            </button>
            <button
              type="button"
              className="btn-icon btn-icon-md"
              data-testid="update-card-stop"
              aria-label="Stop reading"
              title="Stop reading"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => useUpdatesStore.getState().stop()}
            >
              <StopIcon className="w-4 h-4" />
            </button>
            <button
              type="button"
              className="btn-icon btn-icon-md"
              data-testid="update-card-open"
              aria-label="Open its page"
              title="Open its page"
              onClick={() => {
                useUpdatesStore.getState().closeCard()
                openTab(offScreen.sessionId)
              }}
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4" />
            </button>
            <span className="update-card-block">
              {reading.state === 'preparing'
                ? reading.step === 'creating'
                  ? 'Creating the voice'
                  : 'Rewriting for the voice'
                : blockLabel(reading)}
            </span>
          </div>
          {reading.state !== 'preparing' && reading.blocks > 0 && (
            <Scrub
              reading={reading}
              pending={null}
              onSeek={(tick) => useUpdatesStore.getState().seek(tick)}
            />
          )}
          {reading.voice === 'system' && (
            <p className="update-card-note">{macVoiceLine(reading.why)}</p>
          )}
          {reading.fallback && (
            <p className="update-card-note" data-tone="quiet">
              {fallbackLine(reading.fallback)}
            </p>
          )}
        </section>
      )}

      {updates.length > 0 && (
        <ol className="update-card-list" aria-label="Waiting updates">
          {updates.map((update, i) => {
            const name = updateName(update.sessionId, sessions, groups)
            return (
              <li
                key={update.id}
                className="update-row"
                data-testid="update-row"
                data-session-id={update.sessionId}
              >
                <div className="update-row-text">
                  <p className="update-card-name">{name.group ?? name.tab}</p>
                  <p className="update-card-detail">
                    {name.group ? `${name.tab} · ` : ''}
                    {update.title}
                  </p>
                </div>
                <div className="update-row-actions">
                  {i === 0 && shortcut && !offScreen && (
                    <span className="update-row-key">{shortcut}</span>
                  )}
                  <button
                    type="button"
                    className="btn-icon btn-icon-md"
                    data-testid="update-row-play"
                    aria-label="Play"
                    title="Play"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void useUpdatesStore.getState().play(update.id)}
                  >
                    <PlayIcon className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className="btn-icon btn-icon-md"
                    data-testid="update-row-open"
                    aria-label="Open"
                    title="Open"
                    onClick={() => {
                      useUpdatesStore.getState().closeCard()
                      openTab(update.sessionId)
                    }}
                  >
                    <ArrowTopRightOnSquareIcon className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className="btn-icon btn-icon-md"
                    data-testid="update-row-dismiss"
                    aria-label="Dismiss"
                    title="Dismiss"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => useUpdatesStore.getState().dismiss(update.id)}
                  >
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
