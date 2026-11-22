import './updates.css'
import { useEffect, useRef } from 'react'
import { PauseIcon, PlayIcon } from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import { useShortcutLabel } from '../../store/keymap-store'
import { useUpdatesStore } from '../../store/updates-store'
import { blockLabel, chipShown, spokenName, updateName } from '../../lib/updates'
import { UpdateCard } from './UpdateCard'

/* The update chip (PRDCT-4832), Clave's first in-app notification: in the
   toolbar's right cluster, present only while an update waits or a reading
   plays whose page is not on screen. A play/pause button, then the words,
   which open or close the card. It never takes the keyboard focus when it
   appears, opens or changes: the person may be typing in another tab. */

/** The step words of a reading being prepared, the voice card's. */
const stepWords = (step: 'rewriting' | 'creating' | null): string =>
  step === 'creating' ? 'Creating the voice' : 'Rewriting for the voice'

export function UpdateChip(): React.JSX.Element | null {
  const updates = useUpdatesStore((s) => s.updates)
  const current = useUpdatesStore((s) => s.current)
  const cardOpen = useUpdatesStore((s) => s.cardOpen)
  const sessions = useSessionStore((s) => s.sessions)
  const groups = useSessionStore((s) => s.groups)
  const shortcut = useShortcutLabel('playUpdate')
  const anchor = useRef<HTMLDivElement>(null)
  const shown = chipShown(updates, current)
  const offScreen = current && !current.onScreen ? current : null

  // Empty of both, the card closes itself and the chip goes.
  useEffect(() => {
    if (!shown && cardOpen) useUpdatesStore.getState().closeCard()
  }, [shown, cardOpen])

  if (!shown) return null
  const name = spokenName(updateName(shown.sessionId, sessions, groups))
  const playing = shown.state === 'playing'
  const hint = shortcut ? ` (${shortcut})` : ''
  const fraction =
    offScreen && offScreen.reading.blocks > 0
      ? Math.min(
          1,
          (offScreen.reading.tick + offScreen.reading.fraction) / offScreen.reading.blocks
        )
      : 0

  return (
    <div ref={anchor} className="update-chip-anchor">
      <div
        className="update-chip"
        data-testid="update-chip"
        data-state={shown.state}
        style={{ '--update-progress': fraction } as React.CSSProperties}
      >
        <button
          type="button"
          className="btn-icon btn-icon-md update-chip-play"
          title={
            playing
              ? `Pause the reading${hint}`
              : shown.state === 'paused'
                ? `Resume the reading${hint}`
                : shown.state === 'preparing'
                  ? `Preparing the reading${hint}`
                  : `Play the update${hint}`
          }
          aria-label={playing ? 'Pause the reading' : 'Play the update'}
          // A click never moves the focus off what the person was typing in.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void useUpdatesStore.getState().toggle()}
        >
          {playing ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4" />}
        </button>
        <button
          type="button"
          className="update-chip-text"
          aria-expanded={cardOpen !== null}
          aria-label={cardOpen ? 'Close the updates' : 'Open the updates'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const store = useUpdatesStore.getState()
            if (store.cardOpen === 'pinned') store.closeCard()
            else store.openCard('pinned')
          }}
        >
          <span className="update-chip-name">
            {shown.state === 'waiting' ? `Update on ${name}` : name}
          </span>
          {shown.state === 'waiting' && shown.more > 0 && (
            <span className="update-chip-more">+{shown.more}</span>
          )}
          {offScreen && shown.state === 'preparing' && (
            <span className="update-chip-step">{stepWords(offScreen.reading.step)}</span>
          )}
          {offScreen && shown.state === 'playing' && (
            <span className="update-chip-step">{blockLabel(offScreen.reading)}</span>
          )}
          {shown.state === 'paused' && <span className="update-chip-step">Paused</span>}
        </button>
        {offScreen && <span className="update-chip-progress" aria-hidden="true" />}
      </div>
      {cardOpen && <UpdateCard mode={cardOpen} anchor={anchor} />}
    </div>
  )
}
