import { useContext, useEffect, useState } from 'react'
import { ArrowUturnLeftIcon } from '@heroicons/react/24/outline'
import { RISK_LABELS } from '../../../src/shared/permission-risk'
import type { Permission } from './reducer'
import {
  PermissionReadingContext,
  READING_GIVE_UP_MS,
  shownLevel
} from './permission-reading-context'
import './permission-reading.css'

/* What a permission request does, in plain words (PRDCT-4331), drawn inside
   the existing card: the level from the rules at once, "Reading what this
   does…" while the session's host reads it, then the sentence. The card is
   answerable from its first frame; nothing here holds a button back. The
   level shown is the rules' floor raised by the host's reading, never
   lowered: the same rule the host applies, held here too so an older host's
   word can never bring a level down. */

const MATCH_WORDS: Record<string, string> = {
  no: 'Not what you asked for'
}

/** The level and the reading, inside the permission card. */
export function PermissionReading({ request }: { request: Permission }): React.JSX.Element {
  const value = useContext(PermissionReadingContext)
  const reading = value?.explained[request.id]
  const level = shownLevel(request, reading, value?.cwd)
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (reading) return
    const timer = setTimeout(() => setGaveUp(true), READING_GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [reading])
  const loading = !!value && !reading && !gaveUp
  return (
    <div
      className="chat-permission-reading"
      data-level={level ?? 'unknown'}
      data-state={reading?.sentence ? 'read' : loading ? 'reading' : 'none'}
    >
      <span className="chat-permission-level" data-level={level ?? 'unknown'}>
        {level ? RISK_LABELS[level] : 'Not verified'}
      </span>
      {reading?.sentence ? (
        <p className="chat-permission-sentence">
          {reading.sentence}
          {reading.asked && MATCH_WORDS[reading.asked] && (
            <span className="chat-permission-match" data-asked={reading.asked}>
              {MATCH_WORDS[reading.asked]}
            </span>
          )}
        </p>
      ) : (
        loading && (
          <p className="chat-permission-sentence" data-loading="true" aria-live="polite">
            Reading what this does…
          </p>
        )
      )}
    </div>
  )
}

/** The way back for a tab launched with permissions skipped: one quiet
 *  action on the card, which sends the switch. Nothing when there is none. */
export function BackToBypass(): React.JSX.Element | null {
  const value = useContext(PermissionReadingContext)
  if (!value?.backToBypass) return null
  return (
    <button
      type="button"
      className="chat-permission-bypass"
      onClick={value.backToBypass}
      title="This tab was started with permissions skipped; switch it back"
    >
      <ArrowUturnLeftIcon />
      Back to skipping permissions
    </button>
  )
}

/** The level, small, in the transcript's record of a request. */
export function PermissionLevelTag({ request }: { request: Permission }): React.JSX.Element {
  const value = useContext(PermissionReadingContext)
  const reading = value?.explained[request.id]
  const level = shownLevel(request, reading, value?.cwd)
  return (
    <span
      className="chat-permission-level"
      data-level={level ?? 'unknown'}
      data-size="small"
      title={reading?.sentence}
    >
      {level ? RISK_LABELS[level] : 'Not verified'}
    </span>
  )
}

/** One line of the transcript: the permission mode changed. */
export function ModeLine({
  label,
  fromLabel,
  by
}: {
  label: string
  fromLabel: string
  by?: 'you'
}): React.JSX.Element {
  return (
    <div className="chat-notice chat-mode-line" role="status">
      {by === 'you' ? 'You switched' : 'Switched'} permissions from {fromLabel} to{' '}
      <strong>{label}</strong>
    </div>
  )
}
