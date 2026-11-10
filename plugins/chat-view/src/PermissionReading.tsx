import { useContext, useEffect, useState } from 'react'
import {
  ArrowUturnLeftIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  PencilSquareIcon
} from '@heroicons/react/24/outline'
import { isExplainable, RISK_LABELS, type RiskLevel } from '../../../src/shared/permission-risk'
import type { Permission } from './reducer'
import {
  maySecrets,
  PermissionReadingContext,
  READING_GIVE_UP_MS,
  shownLevel
} from './permission-reading-context'
import './permission-reading.css'

/* What a permission request does, in plain words (PRDCT-4331), drawn inside
   the existing card. The card is answerable from its first frame; nothing
   here holds a button back. The level shown follows the one rule the host
   applies (`shownLevel` in permission-risk.ts), held here too so an older
   host's word can never bring a level down: the reading raises a level the
   rules found, may give one to a request they could not tell, and never
   says "reads only" by itself. */

const MATCH_WORDS: Record<string, string> = {
  no: 'Not what you asked for'
}

const LEVEL_ICONS: Partial<Record<RiskLevel, typeof PencilSquareIcon>> = {
  project: PencilSquareIcon,
  outside: GlobeAltIcon,
  irreversible: ExclamationTriangleIcon
}

/** The level in words, with an icon for the three that change something;
 *  "Not verified" when there is no level to show. Never green: the lowest
 *  level is neutral, and nothing here says "safe". */
function LevelPill({
  level,
  small = false
}: {
  level: RiskLevel | null
  small?: boolean
}): React.JSX.Element {
  const Icon = level ? LEVEL_ICONS[level] : undefined
  return (
    <span
      className="chat-permission-level"
      data-level={level ?? 'unverified'}
      data-size={small ? 'small' : undefined}
    >
      {Icon && <Icon aria-hidden="true" />}
      {level ? RISK_LABELS[level] : 'Not verified'}
    </span>
  )
}

/** The level and the reading, inside the permission card. Before the
 *  reading: the level the rules found (none when they could not tell) and
 *  "Reading what this does…". After: the level, raised by the reading or
 *  given by it to a request the rules could not tell, and the sentence; when
 *  no level is earned, one line that says Clave could not check it and that
 *  the sentence is a model's reading. A reading that failed says so in one
 *  quiet line. */
export function PermissionReading({ request }: { request: Permission }): React.JSX.Element {
  const value = useContext(PermissionReadingContext)
  const reading = value?.explained[request.id]
  const level = shownLevel(request, reading, value?.cwd)
  const read = isExplainable(request)
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (reading || !read) return
    const timer = setTimeout(() => setGaveUp(true), READING_GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [reading, read])
  const waiting = !!value && read && !reading && !gaveUp
  const failed = !!value && read && !reading?.sentence && (!!reading?.failed || gaveUp)
  // The rules could neither prove nor detect a level: the model's sentence is
  // all there is, and the card says so in words rather than in a faint pill
  // beside a confident sentence.
  const unverified = level === null && !!reading?.sentence
  // The rules' note, beside the level or the "Not verified" line: what is
  // read may hold a secret. A hint, in the same neutral ink as the level.
  const secrets = maySecrets(request, value?.cwd) && (level !== null || unverified)
  return (
    <div
      className="chat-permission-reading"
      data-level={level ?? 'unverified'}
      data-state={reading?.sentence ? 'read' : waiting ? 'reading' : failed ? 'failed' : 'none'}
    >
      {!(level === null && (waiting || unverified)) && <LevelPill level={level} />}
      {secrets && <span className="chat-permission-secrets">May show secrets</span>}
      {reading?.sentence ? (
        <p className="chat-permission-sentence" data-verified={unverified ? 'false' : undefined}>
          {unverified && 'Not verified. Clave could not check this; a model reads it as: '}
          {reading.sentence}
          {reading.asked && MATCH_WORDS[reading.asked] && (
            <span className="chat-permission-match" data-asked={reading.asked}>
              {MATCH_WORDS[reading.asked]}
            </span>
          )}
        </p>
      ) : waiting ? (
        <p className="chat-permission-sentence" data-loading="true" aria-live="polite">
          Reading what this does…
        </p>
      ) : (
        failed && <p className="chat-permission-failed">Could not read what this does</p>
      )}
    </div>
  )
}

/** The way back for a tab that skipped permissions before (launched that way,
 *  or resumed from a session that was): one quiet action on the card, which
 *  sends the switch. Nothing when there is none. */
export function BackToBypass(): React.JSX.Element | null {
  const value = useContext(PermissionReadingContext)
  if (!value?.backToBypass) return null
  return (
    <button
      type="button"
      className="chat-permission-bypass"
      onClick={value.backToBypass}
      title="This tab skipped permissions before; switch back to skipping them"
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
  return (
    <span className="chat-permission-tag" title={reading?.sentence}>
      <LevelPill level={shownLevel(request, reading, value?.cwd)} small />
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
