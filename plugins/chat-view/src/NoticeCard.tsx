import { useId } from 'react'
import type React from 'react'
import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import './notice-card.css'

/* The chat's one notice card: what the chat has to tell the person that is
   neither the agent's words nor a question, in one shape. A tone (`info`,
   `warning`, `error`) shown by its icon AND its word, never by colour alone,
   and nothing in it green; an optional drawing on the left, in the hand of
   the chat's figures (`DropDrawing`, `AskDrawing`, `ExchangeDrawing`); a
   title; one or two sentences; optional actions; an optional dismiss. Two
   placements of the same card:

   - docked: above the composer, where the prompt dock and the provider
     switch sit, on their surface and with their rise (`.chat-prompt`).
     Transient: what just happened, gone once it no longer matters.
   - inline: in the transcript's column, the compact form, no lift. A notice
     that belongs to the conversation's history.

   It never takes the caret. Escape dismisses it while the focus is inside
   it; a docked card that Escape should reach from the composer has its view
   route the key too (the drop refusal does, ChatView / TerminalView).

   Callers today: the drop refusal (`DropRefusal.tsx`, docked, PRDCT-4329).
   Callers to come, each expressible with this API as it stands:
   - the chat's end states (`EndedNotice` in ChatView.tsx): the limit reached
     (tone warning, the limit sentence as the title, one action per rung,
     "Continue on …", each carrying its `data-chat-continue-*` hook), no
     account with headroom (warning, no action), moving to another account
     (info, `progress`), the plain end (info, "Session ended (exit n)");
     each with `data={{ 'data-chat-ended': … }}`, placement inline.
   - a server tab's ended state (`ServerEnded.tsx`): info, inline, its
     server drawing, the server's name as the eyebrow, Resume as the primary
     action (`data-chat-resume`), "Resuming…" as `progress`, a failed resume
     as `problem`.
   - the transcript's error rows (ChatView `TranscriptRow`, TerminalEntry):
     error, inline, the message as the body, no title needed. */

export type NoticeTone = 'info' | 'warning' | 'error'
export type NoticePlacement = 'docked' | 'inline'

/** Each tone's icon and word: the tone reads without its colour. */
const NOTICE_TONES: Record<NoticeTone, { word: string; Icon: typeof InformationCircleIcon }> = {
  info: { word: 'Note', Icon: InformationCircleIcon },
  warning: { word: 'Warning', Icon: ExclamationTriangleIcon },
  error: { word: 'Error', Icon: ExclamationCircleIcon }
}

/** Hooks the specs find an element by (`data-chat-resume`, …). */
export type DataHooks = Record<`data-${string}`, string | number>

export interface NoticeAction {
  /** The verb as the person reads it: "Resume", "Continue on Work". */
  label: string
  onClick: () => void
  /** The card's way on, in the action ink. One per card at most. */
  primary?: boolean
  disabled?: boolean
  title?: string
  /** Unique within the card; the label when absent. */
  id?: string
  data?: DataHooks
}

export interface NoticeCardProps {
  tone: NoticeTone
  placement: NoticePlacement
  /** A chat drawing (`<DropDrawing kind="refused" />`, …), left of the words. */
  drawing?: React.ReactNode
  /** Words after the tone's own in the eyebrow ("Warning · Studio"). */
  eyebrow?: string
  title?: React.ReactNode
  /** One or two sentences. */
  body?: React.ReactNode
  /** What went wrong with the card's own action, said as an alert under it. */
  problem?: React.ReactNode
  /** In place of the actions while one runs ("Resuming…"). */
  progress?: React.ReactNode
  actions?: readonly NoticeAction[]
  /** The X and Escape. No X without it. */
  onDismiss?: () => void
  /** `alert` for an error, `status` otherwise, unless said. */
  role?: 'status' | 'alert'
  data?: DataHooks
}

export function NoticeCard({
  tone,
  placement,
  drawing,
  eyebrow,
  title,
  body,
  problem,
  progress,
  actions,
  onDismiss,
  role,
  data
}: NoticeCardProps): React.JSX.Element {
  const titleId = useId()
  const { word, Icon } = NOTICE_TONES[tone]
  return (
    <section
      // Docked, it IS a card of the dock: its surface, its rise, its place
      // among the clicks the Enclave view leaves to the cards.
      className={placement === 'docked' ? 'notice-card chat-prompt' : 'notice-card'}
      data-tone={tone}
      data-placement={placement}
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      aria-labelledby={title ? titleId : undefined}
      onKeyDown={
        onDismiss
          ? (event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              onDismiss()
            }
          : undefined
      }
      {...data}
    >
      {drawing && <div className="notice-card-drawing">{drawing}</div>}
      <div className="notice-card-main">
        <p className="notice-card-eyebrow">
          <Icon aria-hidden="true" />
          <span className="notice-card-tone">{word}</span>
          {eyebrow && <span>· {eyebrow}</span>}
        </p>
        {title && (
          <p id={titleId} className="notice-card-title">
            {title}
          </p>
        )}
        {body && <p className="notice-card-body">{body}</p>}
        {problem && (
          <p className="notice-card-problem" role="alert">
            {problem}
          </p>
        )}
        {progress ? (
          <p className="notice-card-progress">{progress}</p>
        ) : actions?.length ? (
          <div className="notice-card-actions">
            {actions.map((action) => (
              <button
                key={action.id ?? action.label}
                type="button"
                className="chat-prompt-btn"
                data-primary={action.primary ? 'true' : undefined}
                disabled={action.disabled}
                title={action.title}
                onClick={action.onClick}
                {...action.data}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {onDismiss && (
        <button
          type="button"
          className="chat-turn-copy notice-card-dismiss"
          aria-label="Dismiss"
          aria-keyshortcuts="Escape"
          title="Dismiss (Esc)"
          onClick={onDismiss}
        >
          <XMarkIcon />
        </button>
      )}
    </section>
  )
}
