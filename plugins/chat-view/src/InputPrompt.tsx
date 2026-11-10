import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  DocumentIcon,
  FolderOpenIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import {
  answerProblem,
  inputRequestMeta,
  isPathKind,
  isTypedKind,
  type InputAnswer
} from '@clave/contract/input-kinds'
import type { AgentQuestion } from '../../../src/shared/session-model'
import { questionIsPrivate, questionKey } from '../../../src/renderer/src/lib/question-identity'
import { openLink } from '../../../src/renderer/src/lib/open-link'
import type { Entry, Permission } from './reducer'
import type { Answer } from './question-context'
import { Key } from './prompt-bits'
import {
  answersOf,
  forgetCard,
  initialValues,
  isDeny,
  recalled,
  remember,
  type Values
} from './input-request'
import { own } from '@clave/contract/input-kinds'
import { AskDrawing, LinkDrawing } from './AskDrawing'
import {
  cardQuestion,
  nativeAnswers,
  nativeHeadline,
  ownWordsOf,
  pickedOption,
  picksOf,
  takesOwnWords,
  togglePick,
  withOwnWords
} from './question-answers'

/* The card an agent asks the person with through clave_request_input
   (PRDCT-4157): what it asks, in its own words, then one field per question
   in the kind the agent named (a line of text, an e-mail, a login, a number, a
   date, a long text, a choice, a path picked in a dialog, a link to open and
   come back from), every field checked where it is typed, one Send. Drawn
   inline in the transcript under the agent's turn (`InlineQuestion`), in the
   paper of the composer. A `form` lays every field out at once, which is how
   an onboarding asks everything up front; `steps` stands the questions one
   below another, the one being answered open, the others folded to a line.

   The same card asks what an agent asked with its own tool (PRDCT-4322):
   Claude's AskUserQuestion, Codex's request for input, a plugin's question,
   a server's clarification. Each is a choice among its options with the
   person's own words allowed (`cardQuestion`), several questions take the
   steps layout, and the answer goes back as the provider takes it. A choice
   that takes own words carries an answer line under its options: the option
   picked lands there and the person edits it in place, or writes their own.

   The form lives across the agent's turns: the person may answer in the chat
   instead, the agent sets the fields from what was said (clave_input_set),
   and the card follows (`draft`): each field lands with its seat ticked and
   a brief flash, the steps layout moves on to the next open question on its
   own, and an answered step folds into one line above the live one. The
   person's Approve, or the agent's when the person said to go ahead, is the
   end of it. */

const host = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The ids of the cards that already took the focus once: a row scrolled out
 *  of the virtualised transcript mounts again when it comes back, and must not
 *  take the caret from the composer a second time. */
const focused = new Set<string>()

/** A press on one of the card's buttons leaves the focus where it is: a
 *  blur would show the field's problem line, move the buttons down under
 *  the pointer, and the release would land beside the button. */
const keepFocus = (event: React.MouseEvent): void => event.preventDefault()

const isEmpty = (value: InputAnswer | undefined): boolean =>
  value === undefined ||
  (typeof value === 'string' ? value.trim() === '' : value.every((entry) => entry.trim() === ''))

/** A private answer, wherever the card shows it. */
const DOTS = '••••••'

/** Where the card goes on its own after the agent set the question it was
 *  on: the first question, from `from` on, that has no answer yet or whose
 *  answer does not fit (an optional one left empty included, since the
 *  person has not seen it); the count when every one has one (the review
 *  page). The person's own Next goes one page, whatever is on it. */
const nextUnanswered = (
  keys: readonly string[],
  values: Values,
  problems: Record<string, string | null>,
  from: number
): number => {
  for (let i = from; i < keys.length; i++)
    if (isEmpty(own(values, keys[i])) || problems[keys[i]] !== null) return i
  return keys.length
}

/** What a done line of the steps layout reads: the answer as the reader
 *  will see it in the record row; an optional question left empty says so. */
const shownValue = (question: AgentQuestion, value: InputAnswer | undefined): string => {
  if (isEmpty(value)) return 'Left empty'
  if (Array.isArray(value))
    return value
      .map((entry: string) => entry.trim())
      .filter(Boolean)
      .join(', ')
  if (question.kind === 'link') return question.confirm ?? "I'm back"
  return String(value)
}

function Field({
  question,
  value,
  problem,
  busy,
  remote,
  secret = false,
  enterMoves = false,
  autoFocus,
  focusToken = 0,
  onChange,
  onTouch,
  onEnter,
  onPick
}: {
  question: AgentQuestion
  value: InputAnswer | undefined
  problem: string | null
  busy: boolean
  remote: boolean
  /** A private answer (a native question marked secret): typed unseen. */
  secret?: boolean
  /** The agent's own question asked in words alone: its field is one line
   *  that grows, where Enter moves on and Shift+Enter is a new line. */
  enterMoves?: boolean
  autoFocus: boolean
  /** Changes when the reader reopens this question from its folded line:
   *  the field takes the caret at the end of the answer, to edit it. */
  focusToken?: number
  onChange: (value: InputAnswer) => void
  onTouch: () => void
  /** Enter in a one-line field: the next field, or the answer on the last. */
  onEnter: () => void
  /** A single choice picked, or a link confirmed: the page may move on,
   *  with the value just picked (state has not caught up yet). */
  onPick?: (value: InputAnswer) => void
}): React.JSX.Element {
  const kind = question.kind ?? 'text'
  const key = questionKey(question)
  const id = `chat-field-${key.replace(/[^a-z0-9_-]/gi, '-')}`
  const [opened, setOpened] = useState(false)
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  /* A multi-select's line of own words, as typed: held here, so a word on
     its way that reads like an option ("No" on the way to "No idea") is never
     taken for that option. Read again from the answer when someone else
     changes it (the agent's fill, a remount). */
  const [ownLine, setOwnLine] = useState(() => ownWordsOf(question, value))
  const produced = useRef<InputAnswer | undefined>(value)
  useEffect(() => {
    if (value === produced.current) return
    produced.current = value
    setOwnLine(ownWordsOf(question, value))
    // The question is the request's, fixed for the field's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  /** The field's own change: remembered, so it is not read back as another's. */
  const change = (next: InputAnswer): void => {
    produced.current = next
    onChange(next)
  }
  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true })
  }, [autoFocus])
  useEffect(() => {
    const el = field.current
    if (!focusToken || !el) return
    el.focus({ preventScroll: true })
    // The caret at the end of what is there: the answer is edited, not retyped.
    if (el instanceof HTMLTextAreaElement || el.type === 'text' || el.type === 'password')
      el.setSelectionRange(el.value.length, el.value.length)
  }, [focusToken])
  /** Enter moves on, Shift+Enter is a new line in a field that takes several. */
  const enterMovesOn = (event: React.KeyboardEvent): void => {
    // ⌘Enter is the card's (one answer, sent once), never the field's too.
    if (event.metaKey || event.ctrlKey) return
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onEnter()
    }
  }
  const invalid = problem !== null
  const describedBy = [question.hint ? `${id}-hint` : '', invalid ? `${id}-problem` : '']
    .filter(Boolean)
    .join(' ')
  const common = {
    id,
    ref: field as never,
    disabled: busy,
    'aria-invalid': invalid ? ('true' as const) : undefined,
    'aria-describedby': describedBy || undefined,
    onBlur: onTouch
  }
  const label = (
    <label className="chat-field-label" htmlFor={id}>
      <span className="chat-field-question">{question.question}</span>
      {question.header && <span className="chat-prompt-hint">{question.header}</span>}
      {question.optional && <span className="chat-prompt-hint">Optional</span>}
    </label>
  )
  const hint = question.hint && (
    <span id={`${id}-hint`} className="chat-field-hint">
      {question.hint}
    </span>
  )
  const trouble = invalid && (
    <span id={`${id}-problem`} className="chat-field-problem" role="alert">
      {problem}
    </span>
  )
  if (kind === 'choice') {
    const words = takesOwnWords(question)
    const answer = typeof value === 'string' ? value : ''
    // A single choice's option is the one its answer starts from, the answer
    // edited or not; a closed choice's answer IS the option.
    // A private answer ticks an option only when it IS that option: a tick
    // on what it starts with would show how the private value starts.
    const chosen = question.multiSelect
      ? null
      : words && !secret
        ? pickedOption(question, answer)
        : question.options.some((o) => o.label === answer)
          ? answer
          : null
    const picks = question.multiSelect ? picksOf(question, value, words ? ownLine : undefined) : []
    const isPicked = (label: string): boolean =>
      question.multiSelect ? picks.includes(label) : chosen === label
    const pick = (label: string): void => {
      if (question.multiSelect) {
        change(togglePick(question, value, label, words ? ownLine : undefined))
        onTouch()
        return
      }
      change(label)
      onTouch()
      onPick?.(label)
    }
    // The answer line: a single choice's whole answer, the option picked
    // landing in it to be edited; a multi-select's own words beside its picks.
    const line = question.multiSelect ? ownLine : answer
    const write = (text: string): void => {
      if (!question.multiSelect) return change(text)
      change(withOwnWords(question, value, ownLine, text))
      setOwnLine(text)
    }
    const lineLabel = question.multiSelect ? 'Your own words' : 'Your answer'
    const linePlaceholder = question.multiSelect
      ? 'Add your own words'
      : 'Pick an option, or write your own answer'
    return (
      <div className="chat-field-wrap" data-kind={kind}>
        <div className="chat-field-label" id={`${id}-label`}>
          <span className="chat-field-question">{question.question}</span>
          {question.header && <span className="chat-prompt-hint">{question.header}</span>}
          {question.multiSelect && <span className="chat-prompt-hint">Choose any</span>}
          {question.optional && <span className="chat-prompt-hint">Optional</span>}
        </div>
        {hint}
        <div
          className="chat-prompt-options"
          role={question.multiSelect ? 'group' : 'radiogroup'}
          aria-labelledby={`${id}-label`}
        >
          {question.options.map((option, index) => {
            const selected = isPicked(option.label)
            return (
              <button
                key={option.label}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={selected}
                className="chat-prompt-option"
                data-selected={selected ? 'true' : undefined}
                data-multi={question.multiSelect ? 'true' : undefined}
                disabled={busy}
                onClick={() => pick(option.label)}
              >
                {question.multiSelect && (
                  <span className="chat-prompt-box" aria-hidden="true">
                    {selected && <CheckIcon />}
                  </span>
                )}
                <span className="chat-prompt-option-text">
                  <span className="chat-prompt-option-label">{option.label}</span>
                  {option.description && (
                    <span className="chat-prompt-option-hint">{option.description}</span>
                  )}
                </span>
                {selected && !question.multiSelect ? (
                  <CheckIcon className="chat-prompt-check" />
                ) : (
                  <Key>{index + 1}</Key>
                )}
              </button>
            )
          })}
        </div>
        {words &&
          (secret ? (
            <input
              {...common}
              type="password"
              autoComplete="off"
              className="chat-field chat-field--answer"
              aria-label={lineLabel}
              placeholder={linePlaceholder}
              value={line}
              onChange={(event) => write(event.target.value)}
              onKeyDown={enterMovesOn}
            />
          ) : (
            <textarea
              {...common}
              rows={1}
              className="chat-field chat-field--answer"
              aria-label={lineLabel}
              placeholder={linePlaceholder}
              value={line}
              onChange={(event) => write(event.target.value)}
              onKeyDown={enterMovesOn}
            />
          ))}
        {trouble}
      </div>
    )
  }
  if (kind === 'link') {
    const done = value === 'done'
    return (
      <div className="chat-field-wrap" data-kind={kind}>
        <div className="chat-field-label" id={`${id}-label`}>
          <span className="chat-field-question">{question.question}</span>
          {question.header && <span className="chat-prompt-hint">{question.header}</span>}
        </div>
        {hint}
        <div className="chat-link" data-done={done ? 'true' : undefined}>
          <LinkDrawing />
          <div className="chat-link-body">
            <span className="chat-link-host">{host(question.url ?? '')}</span>
            <div className="chat-link-actions">
              <button
                type="button"
                className="chat-prompt-btn"
                data-primary={!opened && !done ? 'true' : undefined}
                disabled={busy || !question.url}
                onClick={() => {
                  setOpened(true)
                  void openLink(question.url ?? '', { external: true })
                }}
              >
                <ArrowTopRightOnSquareIcon />
                Open in the browser
              </button>
              {done ? (
                <span className="chat-field-ok">
                  <CheckIcon />
                  {question.confirm ?? "I'm back"}
                </span>
              ) : (
                <button
                  type="button"
                  className="chat-prompt-btn"
                  data-primary={opened ? 'true' : undefined}
                  disabled={busy}
                  onClick={() => {
                    change('done')
                    onTouch()
                    onPick?.('done')
                  }}
                >
                  {question.confirm ?? "I'm back"}
                </button>
              )}
            </div>
          </div>
        </div>
        {trouble}
      </div>
    )
  }
  if (kind === 'long-text') {
    // The agent's own question in words alone keeps the name it gave the
    // field (its header, else its question), as its answer always had.
    const named = enterMoves ? { 'aria-label': question.header ?? question.question } : {}
    return (
      <div className="chat-field-wrap" data-kind={kind}>
        {label}
        {hint}
        {secret ? (
          <input
            {...common}
            {...named}
            type="password"
            autoComplete="off"
            className="chat-field"
            placeholder={question.placeholder}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => change(event.target.value)}
            onKeyDown={enterMovesOn}
          />
        ) : enterMoves ? (
          <textarea
            {...common}
            {...named}
            rows={1}
            className="chat-field chat-field--answer"
            placeholder={question.placeholder ?? 'Write your answer'}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => change(event.target.value)}
            onKeyDown={enterMovesOn}
          />
        ) : (
          <textarea
            {...common}
            className="chat-field chat-field--long"
            rows={3}
            placeholder={question.placeholder}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => change(event.target.value)}
          />
        )}
        {trouble}
      </div>
    )
  }
  if (isPathKind(kind)) {
    const pick = async (): Promise<void> => {
      const current = typeof value === 'string' && value ? value : undefined
      const path =
        kind === 'file'
          ? await window.electronAPI.openFileDialog(current)
          : await window.electronAPI.openFolderDialog(current)
      if (path) {
        change(path)
        onTouch()
      }
    }
    return (
      <div className="chat-field-wrap" data-kind={kind}>
        {label}
        {hint ?? (remote && <span className="chat-field-hint">A path on the server</span>)}
        <div className="chat-field-row">
          <input
            {...common}
            type="text"
            className="chat-field"
            spellCheck={false}
            autoComplete="off"
            placeholder={
              question.placeholder ?? (kind === 'file' ? '/path/to/file' : '/path/to/folder')
            }
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => change(event.target.value)}
            onKeyDown={(event) => {
              if (event.metaKey || event.ctrlKey) return
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                onEnter()
              }
            }}
          />
          {!remote && (
            <button
              type="button"
              className="chat-prompt-btn"
              disabled={busy}
              onClick={() => void pick()}
            >
              {kind === 'file' ? <DocumentIcon /> : <FolderOpenIcon />}
              Choose
            </button>
          )}
        </div>
        {trouble}
      </div>
    )
  }
  // A line of text, typed: text, email, url, github-login, number, date.
  const typed = isTypedKind(kind) ? kind : 'text'
  return (
    <div className="chat-field-wrap" data-kind={kind}>
      {label}
      {hint}
      <input
        {...common}
        type={typed === 'date' ? 'date' : 'text'}
        className="chat-field"
        inputMode={
          typed === 'email'
            ? 'email'
            : typed === 'url'
              ? 'url'
              : typed === 'number'
                ? 'decimal'
                : undefined
        }
        autoComplete={typed === 'email' ? 'email' : typed === 'url' ? 'url' : 'off'}
        autoCapitalize={typed === 'text' ? undefined : 'none'}
        spellCheck={typed === 'text'}
        placeholder={question.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey) return
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            onEnter()
          }
        }}
      />
      {trouble}
    </div>
  )
}

/** One step's answer as the folded line and the record read it. */
const answerText = (question: AgentQuestion, value: InputAnswer | undefined): string =>
  shownValue(question, value)

/** How long the reader's typing rests before it reaches the form's draft. */
const TYPING_SYNC_MS = 400

export function InputPrompt({
  request,
  busy,
  agent,
  remote,
  drafts,
  draft,
  typed,
  notes,
  working = false,
  onAnswer,
  onType
}: {
  request: Permission
  busy: boolean
  agent: string
  remote: boolean
  drafts?: Map<string, Values>
  /** The fields the agent set so far (the entry's `draft`): applied as they
   *  arrive, over what the reader has not typed otherwise. */
  draft?: Values
  /** What the reader had typed, as the server kept it (the entry's `typed`,
   *  PRDCT-4210): a card that comes late starts from it, silently. */
  typed?: Values
  /** The agent's word under a field it could not fill, by key. */
  notes?: Record<string, string>
  /** The agent is answering what the reader just wrote: the step the reader
   *  is on shows it working on it. */
  working?: boolean
  onAnswer: Answer
  /** Where the reader's typing goes as it changes (PRDCT-4210): the form's
   *  draft on the server, so the agent reads it and its submit approves it.
   *  Called with the fields that changed, an emptied one as `''`. */
  onType?: (id: string, answers: Record<string, string | string[]>) => void
}): React.JSX.Element {
  const meta = inputRequestMeta(request.input)
  /* What asks: a form (clave_request_input), the agent's own question, or a
     plugin's question, whose choice IS the answer and which carries no
     questions of its own, only its description and its options. */
  const how: 'hosted' | 'native' | 'plugin' = meta
    ? 'hosted'
    : request.questions
      ? 'native'
      : 'plugin'
  const asked: AgentQuestion[] = request.questions ?? [
    { question: request.description, options: request.options.map((o) => ({ label: o.label })) }
  ]
  const questions = asked.map((q) => cardQuestion(q, how))
  const keys = questions.map(questionKey)
  const secretOf = (question: AgentQuestion): boolean =>
    how !== 'hosted' && questionIsPrivate(question, request.input)
  // A card with nothing of its view's own (a view mounted again) starts from
  // what the server's draft holds: the agent's fields, then the reader's
  // typing over them (verifier round 1, Major 2).
  const [values, setValues] = useState<Values>(() =>
    drafts?.get(request.id)
      ? initialValues(request, drafts)
      : { ...initialValues(request, drafts), ...draft, ...typed }
  )
  const [kept] = useState(() => recalled(request.id))
  const [touched, setTouchedState] = useState<Record<string, boolean>>(kept.touched)
  const [attempted, setAttemptedState] = useState(kept.attempted)
  const [step, setStepState] = useState(kept.step)
  const [direction, setDirectionState] = useState<'forward' | 'back'>(kept.direction)
  /** Per field, how many times the agent set it: each landing flashes once. */
  const [landed, setLandedState] = useState<Record<string, number>>(kept.landed)
  /** The notes the reader typed over: gone until a new one arrives. */
  const [dismissed, setDismissed] = useState<Record<string, string>>({})
  // Every change of standing is remembered as it is made (CardMemory).
  const setStep = (next: number): void => {
    remember(request.id, { step: next })
    setStepState(next)
  }
  const setDirection = (next: 'forward' | 'back'): void => {
    remember(request.id, { direction: next })
    setDirectionState(next)
  }
  const setAttempted = (next: boolean): void => {
    remember(request.id, { attempted: next })
    setAttemptedState(next)
  }
  const setTouched = (
    update: (current: Record<string, boolean>) => Record<string, boolean>
  ): void =>
    setTouchedState((current) => {
      const next = update(current)
      remember(request.id, { touched: next })
      return next
    })
  const setLanded = (update: (current: Record<string, number>) => Record<string, number>): void =>
    setLandedState((current) => {
      const next = update(current)
      remember(request.id, { landed: next })
      return next
    })
  const body = useRef<HTMLDivElement>(null)
  // Several questions the agent asked with its own tool stand one below
  // another, as a form asked in steps does.
  const steps = (meta ? meta.layout === 'steps' : true) && questions.length > 1
  // In the steps layout `step` runs from 0 to the count: at the count every
  // question is folded into its line, with the answer button under them.
  const review = steps && step >= questions.length
  const shown = steps ? (review ? [] : [questions[step]]) : questions
  const firstKind = shown[0]?.kind
  const last = !steps || step >= questions.length - 1
  const skip = request.options.find((o) => isDeny(o.id))
  const problemsOf = (vals: Values): Record<string, string | null> =>
    Object.fromEntries(
      questions.map((q) => [questionKey(q), answerProblem(q, own(vals, questionKey(q)))])
    ) as Record<string, string | null>
  const problems = problemsOf(values)
  const valid = Object.values(problems).every((p) => p === null)
  const byAgent = Object.keys(landed).length > 0
  // The first card for this request takes the caret, once; the body itself
  // takes it when the first field is a choice or a link.
  const [takeFocus] = useState(() => {
    if (focused.has(request.id)) return false
    focused.add(request.id)
    return true
  })
  useEffect(() => {
    if (!takeFocus) return
    if (firstKind === 'choice' || firstKind === 'link') body.current?.focus({ preventScroll: true })
  }, [takeFocus, firstKind])
  // The reader's typing reaches the form's draft (PRDCT-4210): a beat after
  // the last change, the fields that differ from what the server holds
  // (`synced`), so a field the agent set is never sent back as typed. An
  // answer or a skip carries every value itself and drops what is waiting;
  // a card that unmounts sends it at once. Only the fields the reader edited
  // since the last send go (`dirty`): a field the card shows otherwise, a
  // default or one a remount left empty, is never sent over the agent's
  // (verifier round 1, Major 2).
  const synced = useRef<Values>({ ...typed, ...kept.synced })
  const dirty = useRef(new Set<string>())
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flush = (): void => {
    if (typing.current) clearTimeout(typing.current)
    typing.current = null
    const edited = [...dirty.current]
    dirty.current.clear()
    if (!onType) return
    const wire = answersOf(questions, valuesRef.current)
    const patch: Record<string, string | string[]> = {}
    for (const key of edited) {
      const value = wire[key] ?? ''
      if (JSON.stringify(value) !== JSON.stringify(own(synced.current, key) ?? ''))
        patch[key] = value
    }
    if (!Object.keys(patch).length) return
    synced.current = { ...synced.current, ...patch }
    // The server now holds the reader's value there, so the agent setting
    // the field again, to the value it once set, is a change the card must
    // show (verifier round 1, Major 1).
    const forgotten = { ...applied.current }
    for (const key of Object.keys(patch)) delete forgotten[key]
    applied.current = forgotten
    remember(request.id, { synced: synced.current, applied: applied.current })
    onType(request.id, patch)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  // Only typing still waiting is sent on the way out: a copy of the card in
  // a hidden view, or one just answered, has nothing of the reader's to send.
  useEffect(
    () => () => {
      if (typing.current) flushRef.current()
    },
    []
  )
  const dropTyping = (): void => {
    if (typing.current) clearTimeout(typing.current)
    typing.current = null
    dirty.current.clear()
  }
  const set = (key: string, value: InputAnswer): void => {
    if (notes?.[key]) setDismissed((current) => ({ ...current, [key]: notes[key] }))
    setValues((current) => {
      const next = { ...current, [key]: value }
      drafts?.set(request.id, next)
      return next
    })
    if (!onType) return
    dirty.current.add(key)
    if (typing.current) clearTimeout(typing.current)
    typing.current = setTimeout(() => flushRef.current(), TYPING_SYNC_MS)
  }
  const touch = (key: string): void => setTouched((current) => ({ ...current, [key]: true }))
  const shownProblem = (key: string): string | null =>
    attempted || touched[key] ? problems[key] : null
  const noteFor = (key: string): string | undefined => {
    const note = notes?.[key]
    return note && dismissed[key] !== note ? note : undefined
  }
  const focusField = (key: string): void => {
    const id = `chat-field-${key.replace(/[^a-z0-9_-]/gi, '-')}`
    body.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.focus()
  }
  // The step that opens keeps the reader's keys in the card: the click that
  // moved on (an option picked) left the focus on a row that has just folded,
  // and a digit pressed next must pick on the new question. Only when the
  // focus was the card's, or nobody's: an agent's fill moving the card on
  // never takes the caret from the composer. Not on mount, which has its own
  // rule (`takeFocus`).
  const stepSeen = useRef(step)
  const [firstStep] = useState(step)
  useEffect(() => {
    if (!steps || stepSeen.current === step) return
    stepSeen.current = step
    const card = body.current
    const active = document.activeElement
    if (!card || (active && active !== document.body && !card.contains(active))) return
    // A field of the open step already has the caret (a folded line reopened
    // hands it to its answer): leave it there.
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      !active.closest('[inert]')
    )
      return
    const question = questions[step]
    if (!question || question.kind === 'choice' || question.kind === 'link')
      card.focus({ preventScroll: true })
    else focusField(keys[step])
    // The questions and their keys are the request's, fixed for the card's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, steps])
  // The agent's writes land here: a field it set takes the value (over what
  // the reader typed there, since the agent speaks for what the reader just
  // said), ticks, flashes once, and in the steps layout the card moves on to
  // the next open question a beat later, so the landing is seen.
  const applied = useRef<Values>(kept.applied)
  const stepRef = useRef(step)
  stepRef.current = step
  const valuesRef = useRef(values)
  valuesRef.current = values
  /** The pending move to the next question after an agent's write; one at
   *  a time, judged when it fires on the values of that moment, and never
   *  cancelled by a second write landing before it. */
  const moving = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (moving.current) clearTimeout(moving.current)
    },
    []
  )
  useEffect(() => {
    if (!draft) return
    const changed = Object.entries(draft).filter(
      ([key, value]) =>
        keys.includes(key) && JSON.stringify(applied.current[key]) !== JSON.stringify(value)
    )
    if (!changed.length) return
    applied.current = { ...applied.current, ...Object.fromEntries(changed) }
    // The server holds what the agent set: the reader's typing is told
    // apart from it (PRDCT-4210).
    synced.current = { ...synced.current, ...Object.fromEntries(changed) }
    remember(request.id, { applied: applied.current, synced: synced.current })
    setValues((current) => {
      const next = { ...current, ...Object.fromEntries(changed) }
      drafts?.set(request.id, next)
      return next
    })
    setTouched((current) => ({
      ...current,
      ...Object.fromEntries(changed.map(([key]) => [key, true]))
    }))
    setLanded((current) => ({
      ...current,
      ...Object.fromEntries(changed.map(([key]) => [key, (current[key] ?? 0) + 1]))
    }))
    if (!steps || moving.current) return
    const currentKey = keys[stepRef.current]
    if (currentKey === undefined || !changed.some(([key]) => key === currentKey)) return
    moving.current = setTimeout(() => {
      moving.current = null
      const at = stepRef.current
      const key = keys[at]
      if (key === undefined) return
      const vals = valuesRef.current
      const judged = problemsOf(vals)
      if (isEmpty(own(vals, key)) || judged[key] !== null) return
      setDirection('forward')
      setStep(nextUnanswered(keys, vals, judged, at + 1))
    }, 520)
    // The keys and the questions are the request's, fixed for the card's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  // The reader's typing kept by the server, handed to this view late (a
  // reload, a view that mounted after the typing): it fills a field the card
  // holds nothing in, as the reader left it, with no landing (PRDCT-4210).
  useEffect(() => {
    if (!typed) return
    const fresh = Object.entries(typed).filter(
      ([key]) => keys.includes(key) && isEmpty(own(valuesRef.current, key))
    )
    synced.current = { ...typed, ...synced.current }
    if (!fresh.length) return
    setValues((current) => {
      const next = { ...current, ...Object.fromEntries(fresh) }
      drafts?.set(request.id, next)
      return next
    })
    // The keys are the request's, fixed for the card's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed])
  /** The answer, judged on `vals`: the state, or the state plus the value
   *  just picked, which the click that picked it has not yet rendered. */
  const send = (vals: Values = values): void => {
    if (busy) return
    const judged = problemsOf(vals)
    if (Object.values(judged).some((p) => p !== null)) {
      setAttempted(true)
      const first = keys.find((key) => judged[key] !== null)
      if (first) {
        if (steps) {
          setDirection('back')
          setStep(keys.indexOf(first))
        }
        focusField(first)
      }
      return
    }
    dropTyping()
    drafts?.delete(request.id)
    forgetCard(request.id)
    if (how === 'plugin') {
      // A plugin's question is answered by its option's own id.
      const option = request.options.find((o) => o.label === own(vals, keys[0]))
      if (option) onAnswer(request.id, option.id)
      return
    }
    const answers = answersOf(questions, vals)
    onAnswer(request.id, 'answer', how === 'native' ? nativeAnswers(answers) : answers)
  }
  /** One step on: the next page in `steps` (the review page past the last),
   *  the next field in a form, the answer itself on the last. */
  const advance = (from: number, vals: Values = values): void => {
    if (busy) return
    if (steps) {
      if (review) return send(vals)
      const key = keys[step]
      const judged = problemsOf(vals)
      if (judged[key] !== null) {
        touch(key)
        focusField(key)
        return
      }
      if (last) return send(vals)
      setDirection('forward')
      setStep(step + 1)
      return
    }
    const next = keys[from + 1]
    if (next === undefined) send(vals)
    else focusField(next)
  }
  /** A pick moves on and never sends: to the next question still open, or,
   *  every one answered, to the stack folded whole, each answer in sight
   *  above the button that sends them (the stack is the review, no page of
   *  its own). A question reopened and picked again goes back there, not to
   *  the next one already answered. Takes the values with the pick in them,
   *  which the click has not yet rendered. */
  const pickOn = (vals: Values): void => {
    if (busy || !steps) return
    const judged = problemsOf(vals)
    if (judged[keys[step]] !== null) return
    setDirection('forward')
    setStep(nextUnanswered(keys, vals, judged, step + 1))
  }
  const back = (): void => {
    setDirection('back')
    setStep(Math.min(step, questions.length) - 1)
  }
  /** Which field takes the caret after a reopen, and a count so the same
   *  question reopened twice takes it twice. */
  const [reopened, setReopened] = useState<{ key: string; n: number }>({ key: '', n: 0 })
  /** Open a question from its folded line, its field taking the caret: an
   *  answer is changed where it stands, written over or added to. */
  const goTo = (index: number): void => {
    if (busy) return
    setDirection(index < step ? 'back' : 'forward')
    setStep(index)
    setReopened((current) => ({ key: keys[index], n: current.n + 1 }))
  }
  const doSkip = (): void => {
    if (!skip || busy) return
    dropTyping()
    drafts?.delete(request.id)
    forgetCard(request.id)
    onAnswer(request.id, skip.id)
  }
  /** Where each field stands on the rail: done once its answer fits, the
   *  first one not done is where the reader is (active), a field whose
   *  answer does not fit says so (problem), the rest wait (open). */
  const stateOf = (key: string, index: number): 'done' | 'active' | 'problem' | 'open' => {
    const value = own(values, key)
    const filled = !isEmpty(value)
    if (shownProblem(key) !== null) return 'problem'
    if (filled && problems[key] === null) return 'done'
    const firstOpen = shown.findIndex((q) => {
      const k = questionKey(q)
      return !(!isEmpty(own(values, k)) && problems[k] === null)
    })
    return firstOpen === index ? 'active' : 'open'
  }
  // The accent runs down the rail as far as the field the reader is on, and
  // all the way once every field is answered: measured, since fields differ
  // in height, and written as a length the stylesheet draws.
  const list = useRef<HTMLOListElement>(null)
  const measureRail = (): void => {
    const el = list.current
    if (!el) return
    const active =
      el.querySelector<HTMLElement>('[data-state="active"]') ??
      el.querySelector<HTMLElement>('[data-state="problem"]')
    el.style.setProperty('--ask-progress', `${active ? active.offsetTop + 12 : el.offsetHeight}px`)
  }
  useLayoutEffect(measureRail)
  // The rows fold and arrive over a few hundred milliseconds: a length taken
  // at render is stale by the time they settle, so it is taken again as the
  // list changes size and when a transition ends.
  useEffect(() => {
    const el = list.current
    if (!el) return
    const observer = new ResizeObserver(() => measureRail())
    observer.observe(el)
    const settled = (): void => measureRail()
    el.addEventListener('transitionend', settled)
    return () => {
      observer.disconnect()
      el.removeEventListener('transitionend', settled)
    }
  }, [])
  // The rows of the rail. In the steps layout every step up to the one the
  // reader is on has a row of its own, keyed by its question, so a row
  // already there is never drawn again: the step that closes folds its field
  // away and its answer in, the step that opens arrives, the rest stand.
  // In the steps layout every question has its row from the start, keyed by
  // the question, so a row is never drawn again: the step that closes folds
  // its field away and its answer in, the step that opens unfolds, and the
  // ones to come wait below as their question alone.
  const rows = questions
  // A form is approved; the agent's own question is answered, and sent.
  const approveLabel = how === 'hosted' ? 'Approve' : 'Send'
  // A form says what it asks; the agent's own question says it in its fields.
  const ask = how === 'hosted' ? request.description : nativeHeadline(request.description, asked)
  return (
    <div
      ref={body}
      tabIndex={-1}
      className="chat-prompt-body"
      data-layout={steps ? 'steps' : 'form'}
      data-review={review ? 'true' : undefined}
      onKeyDown={(event) => {
        if (busy) return
        if (event.key === 'Escape' && skip) {
          event.preventDefault()
          event.stopPropagation()
          // Escape in a field the person writes in leaves the field, never
          // their words: the card keeps the keys, a second Escape skips.
          if (
            event.target instanceof HTMLTextAreaElement ||
            event.target instanceof HTMLInputElement
          )
            body.current?.focus({ preventScroll: true })
          else doSkip()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          if (steps) advance(step)
          else send()
          return
        }
        if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
          return
        const current = shown[0]
        const n = Number(event.key)
        if (
          current?.kind === 'choice' &&
          Number.isInteger(n) &&
          n >= 1 &&
          n <= current.options.length
        ) {
          event.preventDefault()
          const key = questionKey(current)
          const label = current.options[n - 1].label
          if (current.multiSelect) set(key, togglePick(current, own(values, key), label))
          else {
            set(key, label)
            if (how === 'plugin') send({ ...values, [key]: label })
            else if (steps) pickOn({ ...values, [key]: label })
          }
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (steps) advance(step)
          else send()
        }
      }}
    >
      <div className="chat-ask-head">
        <AskDrawing />
        <div className="chat-ask-words">
          <div className="chat-prompt-head">
            <span className="chat-prompt-eyebrow">{agent} asks</span>
            {steps && !review && (
              <span className="chat-prompt-step">
                {step + 1}/{questions.length}
              </span>
            )}
            <span className="chat-prompt-spacer" />
            {skip && (
              <button
                type="button"
                className="chat-turn-copy"
                aria-label="Skip the question"
                title="Skip (Esc)"
                disabled={busy}
                onMouseDown={keepFocus}
                onClick={doSkip}
              >
                <XMarkIcon />
              </button>
            )}
          </div>
          {ask && <p className="chat-prompt-ask">{ask}</p>}
          {byAgent && (
            <p className="chat-ask-note" role="status">
              {agent.charAt(0).toUpperCase() + agent.slice(1)} filled in what you said. Approve, or
              change a field.
            </p>
          )}
        </div>
      </div>
      <ol ref={list} className="chat-ask-fields" data-direction={direction}>
        {rows.map((question, index) => {
          const key = questionKey(question)
          const active = !steps || index === step
          // Every row but the one being answered is folded to its line: the
          // ones answered above, the ones to come below.
          const folded = steps && !active
          const ahead = steps && index > step
          const secret = secretOf(question)
          const filled = !isEmpty(own(values, key))
          const state = ahead
            ? filled && problems[key] === null
              ? 'done'
              : 'upcoming'
            : folded
              ? problems[key] === null
                ? 'done'
                : 'problem'
              : stateOf(key, steps ? 0 : index)
          const note = noteFor(key)
          return (
            <li
              key={key}
              className="chat-ask-field"
              data-state={state}
              data-folded={folded ? 'true' : undefined}
              data-working={working && active && state !== 'done' ? 'true' : undefined}
              style={{ '--i': index } as React.CSSProperties}
            >
              <span className="chat-ask-seat" aria-hidden="true">
                {state === 'done' && <CheckIcon />}
              </span>
              {landed[key] ? (
                <span key={landed[key]} className="chat-ask-flash" aria-hidden="true" />
              ) : null}
              {steps && (
                <div className="chat-ask-fold" inert={!folded}>
                  <div>
                    <button
                      type="button"
                      className="chat-ask-folded"
                      disabled={busy}
                      title={state === 'upcoming' ? 'Answer this question' : 'Change this answer'}
                      onMouseDown={keepFocus}
                      onClick={() => goTo(index)}
                    >
                      <span className="chat-ask-folded-question">{question.question}</span>
                      <span className="chat-ask-folded-answer">
                        {state === 'upcoming'
                          ? ''
                          : problems[key] !== null
                            ? (problems[key] ?? '')
                            : secret
                              ? DOTS
                              : answerText(question, own(values, key))}
                      </span>
                    </button>
                  </div>
                </div>
              )}
              <div className="chat-ask-open" inert={folded}>
                <div>
                  <Field
                    question={question}
                    value={own(values, key)}
                    problem={shownProblem(key)}
                    busy={busy}
                    remote={remote}
                    secret={secret}
                    enterMoves={how !== 'hosted'}
                    // The card's first caret, once, on the question it opens
                    // on; a choice and a link leave it to the card's keys.
                    autoFocus={
                      takeFocus &&
                      index === (steps ? firstStep : 0) &&
                      question.kind !== 'choice' &&
                      question.kind !== 'link'
                    }
                    focusToken={reopened.key === key ? reopened.n : 0}
                    onChange={(value) => set(key, value)}
                    // Leaving a field one has written in judges it; leaving
                    // it empty (to answer in the chat, say) does not.
                    onTouch={() => {
                      if (!isEmpty(own(values, key))) touch(key)
                    }}
                    onEnter={() => advance(steps ? step : index)}
                    onPick={
                      how === 'plugin'
                        ? (value) => send({ ...values, [key]: value })
                        : steps && !question.multiSelect
                          ? (value) => pickOn({ ...values, [key]: value })
                          : undefined
                    }
                  />
                  {note && !folded && (
                    <span className="chat-field-note" role="status">
                      {note}
                    </span>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="chat-ask-actions">
        {steps && step > 0 && (
          <button
            type="button"
            className="chat-ask-btn"
            onMouseDown={keepFocus}
            disabled={busy}
            onClick={back}
          >
            Back
          </button>
        )}
        <span className="chat-prompt-spacer" />
        {skip && (
          <button
            type="button"
            className="chat-ask-btn"
            onMouseDown={keepFocus}
            title="Skip (Esc)"
            disabled={busy}
            onClick={doSkip}
          >
            Skip
          </button>
        )}
        <button
          type="button"
          className="chat-ask-btn"
          onMouseDown={keepFocus}
          data-primary="true"
          title={steps && !last && !review ? 'Next (Enter)' : `${approveLabel} (⌘ Enter)`}
          disabled={busy || (attempted && !valid)}
          onClick={() => (steps ? advance(step) : send())}
        >
          {steps && !last && !review ? 'Next' : approveLabel}
        </button>
      </div>
    </div>
  )
}

/** The card once it settled, where it stood: the same head, every step
 *  folded with its answer beside it, no buttons; {{Approved}} for a form
 *  ({{Answered}} for the agent's own question), {{Revised}} once the agent
 *  set a field again, {{Skipped}}, or the word that it is no longer awaited.
 *  The record of what was asked and said, read in place. A private answer
 *  is never in the record: its line says it was given, as dots. */
export function ClosedForm({
  entry,
  agent
}: {
  entry: Extract<Entry, { kind: 'permission' }>
  agent: string
}): React.JSX.Element {
  const { request } = entry
  const questions = request.questions ?? []
  const hosted = inputRequestMeta(request.input) !== null
  const skipped = entry.answer !== undefined && isDeny(entry.answer)
  const status = !entry.answer
    ? 'No longer awaiting an answer'
    : skipped
      ? 'Skipped'
      : entry.revised
        ? 'Revised'
        : hosted
          ? 'Approved'
          : 'Answered'
  const ask = hosted ? request.description : nativeHeadline(request.description, questions)
  return (
    <div className="chat-prompt-body" data-layout="steps" data-closed="true">
      <div className="chat-ask-head">
        <AskDrawing />
        <div className="chat-ask-words">
          <div className="chat-prompt-head">
            <span className="chat-prompt-eyebrow">{agent} asked</span>
            <span
              className="chat-ask-status"
              data-status={skipped ? 'skipped' : entry.answer ? 'approved' : 'gone'}
            >
              {status}
            </span>
          </div>
          {ask && <p className="chat-prompt-ask">{ask}</p>}
        </div>
      </div>
      <ol className="chat-ask-fields" style={{ '--ask-progress': '100%' } as React.CSSProperties}>
        {questions.map((question) => {
          const key = questionKey(question)
          const value = entry.answers?.[key]
          const secret = !hosted && questionIsPrivate(question, request.input)
          const given = !!entry.answer && !skipped
          const answered = (value !== undefined && !isEmpty(value)) || (secret && given)
          return (
            <li
              key={key}
              className="chat-ask-field"
              data-state={answered ? 'done' : 'open'}
              data-folded="true"
              style={{ '--i': 0 } as React.CSSProperties}
            >
              <span className="chat-ask-seat" aria-hidden="true">
                {answered && <CheckIcon />}
              </span>
              <div className="chat-ask-fold">
                <div>
                  <span className="chat-ask-folded" data-static="true">
                    <span className="chat-ask-folded-question">{question.question}</span>
                    <span className="chat-ask-folded-answer">
                      {!given ? '' : secret ? DOTS : answerText(question, value)}
                    </span>
                  </span>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
