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
import { questionKey } from '../../../src/renderer/src/lib/question-identity'
import { openLink } from '../../../src/renderer/src/lib/open-link'
import type { Permission } from './reducer'
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

/* The card an agent asks the person with through clave_request_input
   (PRDCT-4157): what it asks, in its own words, then one field per question
   in the kind the agent named (a line of text, an e-mail, a login, a number, a
   date, a long text, a choice, a path picked in a dialog, a link to open and
   come back from), every field checked where it is typed, one Send. Drawn
   inline in the transcript under the agent's turn (`InlineQuestion`), in the
   paper of the composer. A `form` lays every field out at once, which is how
   an onboarding asks everything up front; `steps` takes one question per
   page, the native question's motion. The provider's own question
   (AskUserQuestion, Codex's request_user_input) keeps `QuestionPrompt`.

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
  value === undefined || (typeof value === 'string' ? value.trim() === '' : value.length === 0)

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
  if (Array.isArray(value)) return value.join(', ')
  if (question.kind === 'link') return question.confirm ?? "I'm back"
  return String(value)
}

function Field({
  question,
  value,
  problem,
  busy,
  remote,
  autoFocus,
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
  autoFocus: boolean
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
  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true })
  }, [autoFocus])
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
    const picked = typeof value === 'string' ? [value] : [...((value as readonly string[]) ?? [])]
    const pick = (label: string): void => {
      if (question.multiSelect) {
        onChange(picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label])
        onTouch()
        return
      }
      onChange(label)
      onTouch()
      onPick?.(label)
    }
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
            const selected = picked.includes(option.label)
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
                    onChange('done')
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
  if (kind === 'long-text')
    return (
      <div className="chat-field-wrap" data-kind={kind}>
        {label}
        {hint}
        <textarea
          {...common}
          className="chat-field chat-field--long"
          rows={3}
          placeholder={question.placeholder}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
        {trouble}
      </div>
    )
  if (isPathKind(kind)) {
    const pick = async (): Promise<void> => {
      const current = typeof value === 'string' && value ? value : undefined
      const path =
        kind === 'file'
          ? await window.electronAPI.openFileDialog(current)
          : await window.electronAPI.openFolderDialog(current)
      if (path) {
        onChange(path)
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
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
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
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
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

export function InputPrompt({
  request,
  busy,
  agent,
  remote,
  drafts,
  draft,
  onAnswer
}: {
  request: Permission
  busy: boolean
  agent: string
  remote: boolean
  drafts?: Map<string, Values>
  /** The fields the agent set so far (the entry's `draft`): applied as they
   *  arrive, over what the reader has not typed otherwise. */
  draft?: Values
  onAnswer: Answer
}): React.JSX.Element {
  const meta = inputRequestMeta(request.input)
  const questions = request.questions ?? []
  const keys = questions.map(questionKey)
  const [values, setValues] = useState<Values>(() => initialValues(request, drafts))
  const [kept] = useState(() => recalled(request.id))
  const [touched, setTouchedState] = useState<Record<string, boolean>>(kept.touched)
  const [attempted, setAttemptedState] = useState(kept.attempted)
  const [step, setStepState] = useState(kept.step)
  const [direction, setDirectionState] = useState<'forward' | 'back'>(kept.direction)
  /** Per field, how many times the agent set it: each landing flashes once. */
  const [landed, setLandedState] = useState<Record<string, number>>(kept.landed)
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
  const steps = meta?.layout === 'steps' && questions.length > 1
  // In the steps layout `step` runs from 0 to the count: the count is the
  // review page, every question folded into its line and Approve under them.
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
  const set = (key: string, value: InputAnswer): void =>
    setValues((current) => {
      const next = { ...current, [key]: value }
      drafts?.set(request.id, next)
      return next
    })
  const touch = (key: string): void => setTouched((current) => ({ ...current, [key]: true }))
  const shownProblem = (key: string): string | null =>
    attempted || touched[key] ? problems[key] : null
  const focusField = (key: string): void => {
    const id = `chat-field-${key.replace(/[^a-z0-9_-]/gi, '-')}`
    body.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.focus()
  }
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
    remember(request.id, { applied: applied.current })
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
    drafts?.delete(request.id)
    forgetCard(request.id)
    onAnswer(request.id, 'answer', answersOf(questions, vals))
  }
  /** One step on: the next open question in `steps` (the review page once
   *  every one is answered), the next field in a form, the answer itself on
   *  the last. */
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
  const back = (): void => {
    setDirection('back')
    setStep(Math.min(step, questions.length) - 1)
  }
  const goTo = (index: number): void => {
    if (busy) return
    setDirection(index < step ? 'back' : 'forward')
    setStep(index)
  }
  const doSkip = (): void => {
    if (!skip || busy) return
    drafts?.delete(request.id)
    forgetCard(request.id)
    onAnswer(request.id, skip.id)
  }
  /** Where each field stands on the rail: done once its answer fits, the
   *  first one not done is where the reader is (active), a field whose
   *  answer does not fit says so (problem), the rest wait (open). */
  const stateOf = (key: string, index: number): 'done' | 'active' | 'problem' | 'open' => {
    const value = own(values, key)
    const filled = !(
      value === undefined || (typeof value === 'string' ? value.trim() === '' : value.length === 0)
    )
    if (shownProblem(key) !== null) return 'problem'
    if (filled && problems[key] === null) return 'done'
    const firstOpen = shown.findIndex((q) => {
      const k = questionKey(q)
      const v = own(values, k)
      const f = !(v === undefined || (typeof v === 'string' ? v.trim() === '' : v.length === 0))
      return !(f && problems[k] === null)
    })
    return firstOpen === index ? 'active' : 'open'
  }
  // The accent runs down the rail as far as the field the reader is on, and
  // all the way once every field is answered: measured, since fields differ
  // in height, and written as a length the stylesheet draws.
  const list = useRef<HTMLOListElement>(null)
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const active =
      el.querySelector<HTMLElement>('[data-state="active"]') ??
      el.querySelector<HTMLElement>('[data-state="problem"]')
    el.style.setProperty('--ask-progress', `${active ? active.offsetTop + 12 : el.offsetHeight}px`)
  })
  // The steps already answered, folded into one line each above the live
  // question (or every one, on the review page): the question and what was
  // said, the seat ticked; a click reopens that step.
  const folded = steps ? questions.slice(0, Math.min(step, questions.length)) : []
  const approveLabel = 'Approve'
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
          doSkip()
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
          if (current.multiSelect) {
            const picked = [...((own(values, key) as readonly string[] | undefined) ?? [])]
            set(
              key,
              picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]
            )
          } else {
            set(key, label)
            if (steps) advance(step, { ...values, [key]: label })
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
                onClick={doSkip}
              >
                <XMarkIcon />
              </button>
            )}
          </div>
          <p className="chat-prompt-ask">{request.description}</p>
          {byAgent && (
            <p className="chat-ask-note" role="status">
              {agent} filled in what you said. Approve, or change a field.
            </p>
          )}
        </div>
      </div>
      <ol
        key={steps ? step : 'form'}
        ref={list}
        className="chat-prompt-page chat-ask-fields"
        data-direction={direction}
      >
        {folded.map((question, index) => {
          const key = questionKey(question)
          const fits = problems[key] === null
          return (
            <li
              key={key}
              className="chat-ask-field"
              data-state={fits ? 'done' : 'problem'}
              data-folded="true"
              style={{ '--i': 0 } as React.CSSProperties}
            >
              <span className="chat-ask-seat" aria-hidden="true">
                {fits && <CheckIcon />}
              </span>
              <button
                type="button"
                className="chat-ask-folded"
                onMouseDown={keepFocus}
                disabled={busy}
                title="Change this answer"
                onClick={() => goTo(index)}
              >
                <span className="chat-ask-folded-question">{question.question}</span>
                <span className="chat-ask-folded-answer">
                  {fits ? shownValue(question, own(values, key)) : (problems[key] ?? '')}
                </span>
              </button>
            </li>
          )
        })}
        {shown.map((question, index) => {
          const key = questionKey(question)
          const at = steps ? step : index
          const state = stateOf(key, index)
          return (
            <li
              key={key}
              className="chat-ask-field"
              data-state={state}
              style={{ '--i': steps ? 0 : index } as React.CSSProperties}
            >
              <span className="chat-ask-seat" aria-hidden="true">
                {state === 'done' && <CheckIcon />}
              </span>
              {landed[key] ? (
                <span key={landed[key]} className="chat-ask-flash" aria-hidden="true" />
              ) : null}
              <Field
                question={question}
                value={own(values, key)}
                problem={shownProblem(key)}
                busy={busy}
                remote={remote}
                autoFocus={takeFocus && index === 0}
                onChange={(value) => set(key, value)}
                onTouch={() => touch(key)}
                onEnter={() => advance(at)}
                onPick={
                  steps && !question.multiSelect
                    ? (value) => advance(at, { ...values, [key]: value })
                    : undefined
                }
              />
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
