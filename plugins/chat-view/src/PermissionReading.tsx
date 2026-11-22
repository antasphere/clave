import { useContext, useEffect, useState } from 'react'
import {
  ArrowUturnLeftIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  KeyIcon,
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
   says "reads only" by itself.

   The sentence is a model's estimate and is shown as one, as it is, on every
   card (PRDCT-4873): nothing here says what Clave's own rules could or could
   not check. They prove little on purpose (a closed world: operands inside
   the project, a short list of programs), so "could not check" stood on most
   requests that reach outside it and read as a failure where nothing failed. */

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
 *  no level is earned (the rules cannot tell and the model says it only
 *  reads), the sentence alone. With no reading at all, "Not verified" where
 *  the rules have no level. A reading that failed says so in one quiet line. */
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
  const sentence = reading?.sentence
  // The pill: a level when there is one. With none, nothing while the reading
  // is on its way or once its sentence stands there (a model's "reads only" is
  // a sentence, never a label), and "Not verified" when no reading came. A
  // request the rules read only in part has no level until it is read, then
  // the model's, never under what the readable parts reach (`shownLevel`).
  const pill = level !== null || !(waiting || sentence)
  // The rules' note, beside the pill or the sentence: what is read may hold a
  // secret. A hint, in the same neutral ink as the level.
  const secrets = maySecrets(request, value?.cwd) && (pill || !!sentence)
  return (
    <div
      className="chat-permission-reading"
      data-level={level ?? 'unverified'}
      data-state={sentence ? 'read' : waiting ? 'reading' : failed ? 'failed' : 'none'}
    >
      {pill && <LevelPill level={level} />}
      {secrets && (
        <span className="chat-permission-secrets">
          <KeyIcon aria-hidden="true" />
          May show secrets
        </span>
      )}
      {sentence ? (
        <p className="chat-permission-sentence">
          {sentence}
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
