import { useEffect, useRef, useState } from 'react'
import {
  CheckIcon,
  ChevronRightIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import type { AgentQuestion } from '../../../src/shared/session-model'
import type { Entry, Permission } from './reducer'
import { describeTool, safeJson, type ToolKind } from './tools'
import { ChatCode } from './code'

/* What the agent is waiting on, docked above the composer so it is always in
   the same place and never scrolls away: a tool to allow, or questions to
   answer. The transcript keeps one muted row per request (PermissionRow) as
   the record of what was asked and what the reader said. */

type PermissionEntry = Extract<Entry, { kind: 'permission' }>
export type Answer = (id: string, optionId: string, answers?: Record<string, string>) => void

const stringify = (value: unknown): string => (typeof value === 'string' ? value : safeJson(value))
const isDeny = (id: string): boolean => /deny|decline|cancel|reject|abort/i.test(id)
const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/** The prompt's body takes focus as it arrives, so its keys work at once
 *  without a click; each new request mounts a new body (keyed by id). */
function useFocusOnArrival(): React.RefObject<HTMLDivElement | null> {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => body.current?.focus({ preventScroll: true }), [])
  return body
}

/** A keycap beside a button: the key that presses it. Hidden from the
 *  accessible name, which stays the button's own words. */
function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="chat-prompt-key" aria-hidden="true">
      {children}
    </kbd>
  )
}

const VERBS: Record<ToolKind, string> = {
  read: 'read',
  search: 'search',
  edit: 'edit',
  command: 'run a command',
  skill: 'load the skill',
  web: 'fetch',
  agent: 'start a subagent',
  other: 'use'
}
/** "Allow Claude to write notes.txt?" — the request in the reader's words,
 *  when the tool is one the view knows; the provider's own sentence otherwise. */
function describeRequest(
  request: Permission,
  agent: string
): { title: string; target: string; kind: ToolKind; code?: { text: string; language?: string } } {
  if (!request.toolName) return { title: request.description, target: '', kind: 'other' }
  const tool = describeTool({
    kind: 'tool',
    id: request.id,
    name: request.toolName,
    input: request.input,
    complete: false,
    at: 0
  })
  if (tool.kind === 'other' && !/^mcp__/.test(request.toolName))
    return { title: request.description, target: '', kind: 'other' }
  const verb =
    tool.kind === 'edit' && /write/i.test(request.toolName)
      ? 'write'
      : tool.kind === 'other'
        ? `use ${tool.label}`
        : VERBS[tool.kind]
  const named = tool.kind === 'command' || !tool.target ? '' : ` ${basename(tool.target)}`
  const change = tool.sections.find((s) => s.label !== 'Target' && s.label !== 'Command')
  return {
    title: `Allow ${agent} to ${verb}${named}?`,
    target: tool.kind === 'command' ? '' : tool.target,
    kind: tool.kind,
    code:
      tool.kind === 'command' && tool.target
        ? { text: tool.target, language: 'bash' }
        : change
          ? { text: change.text, language: /^[-+] /m.test(change.text) ? 'diff' : undefined }
          : undefined
  }
}

function PermissionPrompt({
  request,
  agent,
  busy,
  onAnswer
}: {
  request: Permission
  agent: string
  busy: boolean
  onAnswer: Answer
}): React.JSX.Element {
  const { title, target, code } = describeRequest(request, agent)
  // Deny sits on the left, everything that allows on the right with the first
  // option — the provider's own default — last, where the eye ends.
  const denies = request.options.filter((o) => isDeny(o.id))
  const allows = request.options.filter((o) => !isDeny(o.id))
  const ordered = [...denies, ...allows.slice(1).reverse(), ...allows.slice(0, 1)]
  const primary = allows[0]
  const keyOf = (id: string): number => ordered.findIndex((o) => o.id === id) + 1
  const body = useFocusOnArrival()
  return (
    <div
      ref={body}
      tabIndex={-1}
      className="chat-prompt-body"
      onKeyDown={(event) => {
        if (busy) return
        const n = Number(event.key)
        if (Number.isInteger(n) && n >= 1 && n <= ordered.length) {
          event.preventDefault()
          onAnswer(request.id, ordered[n - 1].id)
        } else if (event.key === 'Escape' && denies[0]) {
          event.preventDefault()
          event.stopPropagation()
          onAnswer(request.id, denies[0].id)
        } else if (event.key === 'Enter' && event.metaKey && primary) {
          event.preventDefault()
          onAnswer(request.id, primary.id)
        }
      }}
    >
      <div className="chat-prompt-title">{title}</div>
      {target && <div className="chat-prompt-target">{target}</div>}
      {request.detail && <p className="chat-prompt-detail">{request.detail}</p>}
      {code && (
        <pre className="chat-prompt-code">
          {code.language === 'bash' && <span className="chat-tool-prompt">$ </span>}
          <ChatCode className={code.language ? `language-${code.language}` : undefined}>
            {code.text}
          </ChatCode>
        </pre>
      )}
      {!code && request.input !== undefined && (
        <details className="chat-permission-input">
          <summary>
            <ChevronRightIcon className="chat-tool-chevron" />
            Input
          </summary>
          <pre>{stringify(request.input)}</pre>
        </details>
      )}
      <div className="chat-prompt-actions">
        {denies.map((option) => (
          <button
            key={option.id}
            type="button"
            className="chat-prompt-btn"
            disabled={busy}
            onClick={() => onAnswer(request.id, option.id)}
          >
            {option.label}
            <Key>{keyOf(option.id)}</Key>
            {option === denies[0] && <Key>Esc</Key>}
          </button>
        ))}
        <span className="chat-prompt-spacer" />
        {ordered
          .filter((o) => !isDeny(o.id))
          .map((option) => (
            <button
              key={option.id}
              type="button"
              className="chat-prompt-btn"
              data-primary={option === primary ? 'true' : undefined}
              disabled={busy}
              onClick={() => onAnswer(request.id, option.id)}
            >
              {option.label}
              <Key>{keyOf(option.id)}</Key>
              {option === primary && <Key>⌘↩</Key>}
            </button>
          ))}
      </div>
    </div>
  )
}

/** The reader's reply to one question: the labels picked, or their own words. */
interface Reply {
  picked: string[]
  other: string | null
}
const replyText = (reply: Reply | undefined): string =>
  reply ? [...reply.picked, ...(reply.other?.trim() ? [reply.other.trim()] : [])].join(', ') : ''

function QuestionPrompt({
  request,
  busy,
  onAnswer
}: {
  request: Permission
  busy: boolean
  onAnswer: Answer
}): React.JSX.Element {
  /* A request with `questions` is answered with their text → the reply; one
     without (a plugin's question) offers its options as the choices, and the
     choice IS the answer. Both read as the same card. */
  const structured = request.questions
  const questions: AgentQuestion[] = structured ?? [
    { question: request.description, options: request.options.map((o) => ({ label: o.label })) }
  ]
  const [step, setStep] = useState(0)
  // Which way the page came in: forward swipes from the right, Back from the left.
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [replies, setReplies] = useState<Record<number, Reply>>({})
  const otherInput = useRef<HTMLInputElement>(null)
  const question = questions[step]
  const reply = replies[step] ?? { picked: [], other: null }
  const last = step === questions.length - 1
  const answered = replyText(reply) !== ''
  const skip = request.options.find((o) => isDeny(o.id))
  const set = (next: Reply): void => setReplies((all) => ({ ...all, [step]: next }))
  /** Move on with the replies given: the next question, or the answer itself
   *  on the last one. Takes the replies as an argument because a single choice
   *  moves on in the same click that picks it, before state has caught up. */
  const advance = (all: Record<number, Reply>): void => {
    if (busy || replyText(all[step]) === '') return
    if (!last) {
      setDirection('forward')
      setStep(step + 1)
      return
    }
    if (!structured) {
      const option = request.options.find((o) => o.label === all[step]?.picked[0])
      if (option) onAnswer(request.id, option.id)
      return
    }
    const answers: Record<string, string> = {}
    questions.forEach((q, i) => {
      const text = replyText(all[i])
      if (text) answers[q.question] = text
    })
    onAnswer(request.id, 'answer', answers)
  }
  const submit = (): void => advance(replies)
  /* A multi-select toggles and waits for Next; a single choice IS the answer,
     so picking it moves on at once — no second click on Submit. */
  const pick = (label: string): void => {
    if (question.multiSelect) {
      set({
        ...reply,
        picked: reply.picked.includes(label)
          ? reply.picked.filter((l) => l !== label)
          : [...reply.picked, label]
      })
      return
    }
    const next = { ...replies, [step]: { picked: [label], other: null } }
    setReplies(next)
    advance(next)
  }
  const back = (): void => {
    setDirection('back')
    setStep(step - 1)
  }
  const choices = question.options.length
  const body = useFocusOnArrival()
  // A new step disables the button that moved to it (nothing is chosen yet),
  // which would drop focus out of the dock and its keys with it.
  useEffect(() => body.current?.focus({ preventScroll: true }), [step, body])
  return (
    <div
      ref={body}
      tabIndex={-1}
      className="chat-prompt-body"
      onKeyDown={(event) => {
        if (busy || event.target === otherInput.current) {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
          return
        }
        const n = Number(event.key)
        if (Number.isInteger(n) && n >= 1 && n <= choices + (structured ? 1 : 0)) {
          event.preventDefault()
          if (n <= choices) pick(question.options[n - 1].label)
          else otherInput.current?.focus()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        } else if (event.key === 'Escape' && skip) {
          event.preventDefault()
          event.stopPropagation()
          onAnswer(request.id, skip.id)
        }
      }}
    >
      <div key={step} className="chat-prompt-page" data-direction={direction}>
        <div className="chat-prompt-head">
          {questions.length > 1 && (
            <span className="chat-prompt-step">
              {step + 1}/{questions.length}
            </span>
          )}
          <span className="chat-prompt-title">{question.question}</span>
          {skip && (
            <button
              type="button"
              className="chat-turn-copy"
              aria-label="Skip the question"
              title="Skip (Esc)"
              disabled={busy}
              onClick={() => onAnswer(request.id, skip.id)}
            >
              <XMarkIcon />
            </button>
          )}
        </div>
        <div
          className="chat-prompt-options"
          role={question.multiSelect ? 'group' : 'radiogroup'}
          aria-label={question.header ?? question.question}
        >
          {question.options.map((option, index) => {
            const selected = reply.picked.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={selected}
                className="chat-prompt-option"
                data-selected={selected ? 'true' : undefined}
                disabled={busy}
                onClick={() => pick(option.label)}
              >
                <span className="chat-prompt-option-text">
                  <span className="chat-prompt-option-label">{option.label}</span>
                  {option.description && (
                    <span className="chat-prompt-option-hint">{option.description}</span>
                  )}
                </span>
                {selected ? <CheckIcon className="chat-prompt-check" /> : <Key>{index + 1}</Key>}
              </button>
            )
          })}
          {structured && (
            <label
              className="chat-prompt-option"
              data-selected={reply.other?.trim() ? 'true' : undefined}
            >
              <span className="chat-prompt-option-text">
                <span className="chat-prompt-option-label">Other</span>
                <input
                  ref={otherInput}
                  className="chat-prompt-other"
                  placeholder="Type your own answer"
                  value={reply.other ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    set({
                      picked: question.multiSelect ? reply.picked : [],
                      other: event.target.value
                    })
                  }
                />
              </span>
              <Key>{choices + 1}</Key>
            </label>
          )}
        </div>
      </div>
      <div className="chat-prompt-actions">
        <span className="chat-prompt-spacer" />
        {step > 0 && (
          <button type="button" className="chat-prompt-btn" disabled={busy} onClick={back}>
            Back
          </button>
        )}
        {skip && (
          <button
            type="button"
            className="chat-prompt-btn"
            disabled={busy}
            onClick={() => onAnswer(request.id, skip.id)}
          >
            Skip
            <Key>Esc</Key>
          </button>
        )}
        <button
          type="button"
          className="chat-prompt-btn"
          data-primary="true"
          disabled={busy || !answered}
          onClick={submit}
        >
          {last ? 'Submit' : 'Next'}
          <Key>↩</Key>
        </button>
      </div>
    </div>
  )
}

const isQuestion = (request: Permission): boolean => !!request.questions || !request.toolName

/** The first request the agent still waits on, docked above the composer; the
 *  rest queue behind it. */
export function PromptDock({
  requests,
  agent,
  busy,
  onAnswer
}: {
  requests: Permission[]
  agent: string
  busy: (id: string) => boolean
  onAnswer: Answer
}): React.JSX.Element | null {
  const request = requests[0]
  if (!request) return null
  const question = isQuestion(request)
  return (
    <section
      className="chat-prompt"
      data-kind={question ? 'question' : 'permission'}
      aria-label={question ? 'Question' : 'Permission request'}
    >
      {requests.length > 1 && (
        <div className="chat-prompt-queue">1 of {requests.length} waiting</div>
      )}
      {question ? (
        <QuestionPrompt
          key={request.id}
          request={request}
          busy={busy(request.id)}
          onAnswer={onAnswer}
        />
      ) : (
        <PermissionPrompt
          key={request.id}
          request={request}
          agent={agent}
          busy={busy(request.id)}
          onAnswer={onAnswer}
        />
      )}
    </section>
  )
}

/** The transcript's record of a request: one muted row, like a tool call. */
export function PermissionRow({ entry }: { entry: PermissionEntry }): React.JSX.Element {
  const { request } = entry
  const question = isQuestion(request)
  const Icon = question ? QuestionMarkCircleIcon : ShieldCheckIcon
  const chosen = entry.answer
    ? (request.options.find((o) => o.id === entry.answer)?.label ?? entry.answer)
    : null
  const target = question ? '' : describeRequest(request, '').target
  const subject = question
    ? request.description
    : request.toolName
      ? [request.toolName, target].filter(Boolean).join(' ')
      : request.description
  const answers = entry.answers ? Object.values(entry.answers).join('; ') : null
  const status = entry.answeredElsewhere
    ? 'No longer awaiting an answer'
    : !entry.answer
      ? question
        ? 'Waiting for your answer'
        : 'Waiting for your approval'
      : question
        ? isDeny(entry.answer)
          ? 'Skipped'
          : 'Answered'
        : chosen
  return (
    <div
      className="chat-permission-row"
      data-state={entry.answeredElsewhere ? 'elsewhere' : entry.answer ? 'answered' : 'waiting'}
      data-kind={question ? 'question' : 'permission'}
      role="status"
    >
      <Icon className="chat-tool-status" />
      <span className="chat-permission-row-text">
        <span className="chat-tool-name">{status}</span>
        <span className="chat-tool-summary">{subject}</span>
        {answers && question && <span className="chat-permission-row-answer">→ {answers}</span>}
      </span>
    </div>
  )
}
