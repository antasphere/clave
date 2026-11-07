import { useEffect, useRef, useState } from 'react'
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  DocumentIcon,
  FolderOpenIcon,
  QuestionMarkCircleIcon,
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
import { answersOf, initialValues, isDeny, type Values } from './input-request'
import { LinkDrawing } from './AskDrawing'

/* The card an agent asks the person with through clave_request_input
   (PRDCT-4157): what it asks, in its own words, then one field per question
   in the kind the agent named (a line of text, an e-mail, a login, a number, a
   date, a long text, a choice, a path picked in a dialog, a link to open and
   come back from), every field checked where it is typed, one Send. Drawn
   inline in the transcript under the agent's turn (`InlineQuestion`), in the
   paper of the composer. A `form` lays every field out at once, which is how
   an onboarding asks everything up front; `steps` takes one question per
   page, the native question's motion. The provider's own question
   (AskUserQuestion, Codex's request_user_input) keeps `QuestionPrompt`. */

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
  onAnswer
}: {
  request: Permission
  busy: boolean
  agent: string
  remote: boolean
  drafts?: Map<string, Values>
  onAnswer: Answer
}): React.JSX.Element {
  const meta = inputRequestMeta(request.input)
  const questions = request.questions ?? []
  const keys = questions.map(questionKey)
  const [values, setValues] = useState<Values>(() => initialValues(request, drafts))
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [attempted, setAttempted] = useState(false)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const body = useRef<HTMLDivElement>(null)
  const steps = meta?.layout === 'steps' && questions.length > 1
  const shown = steps ? [questions[step]] : questions
  const firstKind = shown[0]?.kind
  const last = !steps || step === questions.length - 1
  const skip = request.options.find((o) => isDeny(o.id))
  const problemsOf = (vals: Values): Record<string, string | null> =>
    Object.fromEntries(
      questions.map((q) => [questionKey(q), answerProblem(q, vals[questionKey(q)])])
    ) as Record<string, string | null>
  const problems = problemsOf(values)
  const valid = Object.values(problems).every((p) => p === null)
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
  /** The answer, judged on `vals`: the state, or the state plus the value
   *  just picked, which the click that picked it has not yet rendered. */
  const send = (vals: Values = values): void => {
    if (busy) return
    const judged = problemsOf(vals)
    if (Object.values(judged).some((p) => p !== null)) {
      setAttempted(true)
      const first = keys.find((key) => judged[key] !== null)
      if (first) focusField(first)
      return
    }
    drafts?.delete(request.id)
    onAnswer(request.id, 'answer', answersOf(questions, vals))
  }
  /** One step on: the next page in `steps`, the next field in a form, the
   *  answer itself on the last. */
  const advance = (from: number, vals: Values = values): void => {
    if (busy) return
    if (steps) {
      const key = keys[step]
      if (problemsOf(vals)[key] !== null) {
        touch(key)
        focusField(key)
        return
      }
      if (last) send(vals)
      else {
        setDirection('forward')
        setStep(step + 1)
      }
      return
    }
    const next = keys[from + 1]
    if (next === undefined) send(vals)
    else focusField(next)
  }
  const back = (): void => {
    setDirection('back')
    setStep(step - 1)
  }
  const doSkip = (): void => {
    if (!skip || busy) return
    drafts?.delete(request.id)
    onAnswer(request.id, skip.id)
  }
  return (
    <div
      ref={body}
      tabIndex={-1}
      className="chat-prompt-body"
      data-layout={steps ? 'steps' : 'form'}
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
            const picked = [...((values[key] as readonly string[] | undefined) ?? [])]
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
      <div className="chat-prompt-head">
        <span className="chat-prompt-eyebrow">
          <QuestionMarkCircleIcon />
          {agent} asks
        </span>
        {steps && (
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
      <div
        key={steps ? step : 'form'}
        className="chat-prompt-page chat-fields"
        data-direction={direction}
      >
        {shown.map((question, index) => {
          const key = questionKey(question)
          const at = steps ? step : index
          return (
            <Field
              key={key}
              question={question}
              value={values[key]}
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
          )
        })}
      </div>
      <div className="chat-prompt-actions">
        <span className="chat-prompt-spacer" />
        {steps && step > 0 && (
          <button type="button" className="chat-prompt-btn" disabled={busy} onClick={back}>
            Back
          </button>
        )}
        {skip && (
          <button type="button" className="chat-prompt-btn" disabled={busy} onClick={doSkip}>
            Skip
            <Key>Esc</Key>
          </button>
        )}
        <button
          type="button"
          className="chat-prompt-btn"
          data-primary="true"
          disabled={busy || (attempted && !valid)}
          onClick={() => (steps ? advance(step) : send())}
        >
          {steps && !last ? 'Next' : 'Send'}
          <Key>{steps && !last ? '↩' : '⌘↩'}</Key>
        </button>
      </div>
    </div>
  )
}
