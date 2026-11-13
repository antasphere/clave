import { questionKey, questionIsPrivate } from '../../../src/renderer/src/lib/question-identity'
import { useEffect, useRef, useState } from 'react'
import {
  ChevronRightIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon
} from '@heroicons/react/24/outline'
import type { Entry, Permission } from './reducer'
import { describeTool, safeJson, type ApprovalGroup, type ToolKind } from './tools'
import { approvalRunSummary, decisionWord, describeApproval, isQuestion } from './approvals'
import { useDisclosure } from './disclosure'
import { ChatCode } from './code'
import { ClosedForm, InputPrompt } from './InputPrompt'
import { isDeny, isInputRequest, forgetCard } from './input-request'
import { useQuestionHost, type Answer } from './question-context'
import { BackToBypass, PermissionLevelTag, PermissionReading } from './PermissionReading'

export type { Answer } from './question-context'

/* What the agent is waiting on, docked above the composer so it is always in
   the same place and never scrolls away: a tool to allow, or questions to
   answer. Every question, a form or the agent's own, is the one card of
   InputPrompt.tsx (PRDCT-4322). The transcript keeps one row per request
   (PermissionRow) as the record of what was asked and what the reader said. */

type PermissionEntry = Extract<Entry, { kind: 'permission' }>

const stringify = (value: unknown): string => (typeof value === 'string' ? value : safeJson(value))
const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/** The prompt's body takes focus as it arrives, so its keys work at once
 *  without a click; each new request mounts a new body (keyed by id). */
function useFocusOnArrival(): React.RefObject<HTMLDivElement | null> {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => body.current?.focus({ preventScroll: true }), [])
  return body
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
  waiting,
  onAnswer
}: {
  request: Permission
  agent: string
  busy: boolean
  /** How many requests wait in the dock, this one included. */
  waiting: number
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
  // A button carries its words alone (PRDCT-4483). Its keys stay live and are
  // said on approach, in the tooltip, the question card's way ("Skip (Esc)"),
  // and to assistive technology: Escape denies, ⌘ Enter allows, a digit
  // presses the button at that place from the left.
  const keysOf = (option: Permission['options'][number]): { hint: string; aria: string } => {
    const digit = String(keyOf(option.id))
    if (option === denies[0]) return { hint: 'Esc', aria: `Escape ${digit}` }
    if (option === primary) return { hint: '⌘ Enter', aria: `Meta+Enter ${digit}` }
    return { hint: digit, aria: digit }
  }
  const button = (option: Permission['options'][number]): React.JSX.Element => {
    const keys = keysOf(option)
    return (
      <button
        key={option.id}
        type="button"
        // The question card's buttons (`chat-ask-btn`), so the two cards that
        // wait on the reader wear the same ones; `chat-prompt-btn` stays the
        // hook the dock's specs find them by.
        className="chat-prompt-btn chat-ask-btn"
        data-primary={option === primary ? 'true' : undefined}
        title={`${option.label} (${keys.hint})`}
        aria-keyshortcuts={keys.aria}
        disabled={busy}
        onClick={() => onAnswer(request.id, option.id)}
      >
        {option.label}
      </button>
    )
  }
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
      <div className="chat-prompt-head">
        <div className="chat-prompt-title">{title}</div>
        {/* The queue stands level with the question rather than on a line
            of its own above it. */}
        {waiting > 1 && <span className="chat-prompt-queue">1 of {waiting} waiting</span>}
      </div>
      {target && <div className="chat-prompt-target">{target}</div>}
      {/* PRDCT-4331: the level at once, then what the request does in plain words. */}
      <PermissionReading request={request} />
      {/* The agent's own word on the request, said to be its own: the reading
          above is Clave's and a model's, which never take the agent's word
          (PRDCT-4489). */}
      {request.detail && (
        <p className="chat-prompt-detail">
          <span className="chat-prompt-detail-who">
            {agent.charAt(0).toUpperCase() + agent.slice(1)} says:
          </span>{' '}
          {request.detail}
        </p>
      )}
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
        {denies.map(button)}
        <span className="chat-prompt-spacer" />
        {ordered.filter((o) => !isDeny(o.id)).map(button)}
      </div>
      <BackToBypass />
    </div>
  )
}

/** The first request the agent still waits on, docked above the composer; the
 *  rest queue behind it. */
export function PromptDock({
  requests,
  agent,
  busy,
  onAnswer,
  remote = false
}: {
  requests: Permission[]
  agent: string
  busy: (id: string) => boolean
  onAnswer: Answer
  /** The session runs on another machine: a path picked here would be this Mac's. */
  remote?: boolean
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
      {question && requests.length > 1 && (
        <div className="chat-prompt-queue">1 of {requests.length} waiting</div>
      )}
      {question ? (
        <InputPrompt
          key={request.id}
          request={request}
          busy={busy(request.id)}
          agent={agent}
          remote={remote}
          onAnswer={onAnswer}
        />
      ) : (
        <PermissionPrompt
          key={request.id}
          request={request}
          agent={agent}
          busy={busy(request.id)}
          waiting={requests.length}
          onAnswer={onAnswer}
        />
      )}
    </section>
  )
}

/** A question still waiting, drawn in the transcript where the agent asked it
 *  (PRDCT-4157): the same card the dock held, inline under the agent's turn,
 *  with the room of the column. The view provides how it answers
 *  (`QuestionContext`); without a provider (a view that keeps its dock) the
 *  row is the muted record as before. The answered card collapses into that
 *  record (`PermissionRow`). */
export function InlineQuestion({ entry }: { entry: PermissionEntry }): React.JSX.Element {
  const host = useQuestionHost()
  const { request } = entry
  if (
    !host ||
    entry.answer ||
    entry.answeredElsewhere ||
    !isQuestion(request) ||
    !host.live(entry)
  ) {
    if (entry.answer || entry.answeredElsewhere) forgetCard(request.id)
    return <PermissionRow entry={entry} />
  }
  const busy = host.busy(request.id)
  // The form's own road (the agent's fill, the reader's typing kept by the
  // server, the agent at work on what was said) is a form's alone: the agent
  // that asked with its own tool waits on the card and fills nothing.
  const hosted = isInputRequest(request)
  return (
    <section className="chat-prompt" data-kind="question" data-inline="true" aria-label="Question">
      <InputPrompt
        key={request.id}
        request={request}
        busy={busy}
        agent={host.agent}
        remote={host.remote}
        drafts={host.drafts}
        {...(hosted && {
          draft: entry.draft,
          typed: entry.typed,
          notes: entry.notes,
          working: host.working,
          onType: host.type
        })}
        onAnswer={host.answer}
      />
    </section>
  )
}

/** The reader's answers to a request's questions, one line each, the way the
 *  record reads them: a multi-select's labels together, a confirmed link as
 *  its button's words, a private answer as dots. */
function AnswerList({
  request,
  answers
}: {
  request: Permission
  answers: Record<string, string | string[]>
}): React.JSX.Element {
  return (
    <dl className="chat-permission-answers">
      {(request.questions ?? []).flatMap((q) => {
        const value = answers[questionKey(q)]
        if (value === undefined) return []
        const text = Array.isArray(value)
          ? value.join(', ')
          : q.kind === 'link'
            ? (q.confirm ?? "I'm back")
            : value
        return [
          <div key={questionKey(q)} className="chat-permission-answer">
            <dt>{q.question}</dt>
            <dd>{questionIsPrivate(q, request.input) ? '••••••' : text}</dd>
          </div>
        ]
      })}
    </dl>
  )
}

/** The transcript's record of a request: one muted row, like a tool call.
 *  It reads what was asked in the reader's words (`describeApproval`: "Run a
 *  command", "Use clave_send_to_session · Clave") and what the reader said
 *  ("Allowed", "Declined"), never the protocol's method name and raw
 *  decision id the Codex adapter carries. */
export function PermissionRow({ entry }: { entry: PermissionEntry }): React.JSX.Element {
  const host = useQuestionHost()
  const { request } = entry
  const question = isQuestion(request)
  // A question stays as the card it was, closed: every step folded with its
  // answer, where it stood when it settled (PRDCT-4157), the agent's own
  // question as much as a form (PRDCT-4322). A plugin's question, which
  // carries no questions of its own, keeps its one muted row.
  if (isQuestion(request) && request.questions?.length && (entry.answer || entry.answeredElsewhere))
    return (
      <div
        className="chat-permission-row"
        data-state={entry.answer ? 'answered' : 'elsewhere'}
        data-kind="question"
        data-revised={entry.revised ? 'true' : undefined}
        data-form="closed"
        role="status"
      >
        <ClosedForm entry={entry} agent={host?.agent ?? 'The agent'} />
      </div>
    )
  const Icon = question ? QuestionMarkCircleIcon : ShieldCheckIcon
  const chosen = entry.answer ? decisionWord(request, entry.answer) : null
  const approval = question
    ? undefined
    : (describeApproval(request) ?? {
        label: request.toolName ?? request.description,
        target: describeRequest(request, '').target
      })
  const subject = approval
    ? [approval.label, approval.target].filter(Boolean).join(' ')
    : request.description
  const hosted = isInputRequest(request)
  const answers = entry.answers
    ? Object.values(entry.answers)
        .map((v) => (Array.isArray(v) ? v.join(', ') : v))
        .join('; ')
    : null
  // An answer on the entry is the truth, whatever the kernel said meanwhile.
  const status =
    entry.answeredElsewhere && !entry.answer
      ? 'No longer awaiting an answer'
      : !entry.answer
        ? question
          ? 'Waiting for your answer'
          : 'Waiting for your approval'
        : question
          ? isDeny(entry.answer)
            ? 'Skipped'
            : entry.revised
              ? 'Revised'
              : 'Answered'
          : chosen
  return (
    <div
      className="chat-permission-row"
      data-state={entry.answer ? 'answered' : entry.answeredElsewhere ? 'elsewhere' : 'waiting'}
      data-kind={question ? 'question' : 'permission'}
      data-revised={entry.revised ? 'true' : undefined}
      role="status"
    >
      <Icon className="chat-tool-status" />
      <span className="chat-permission-row-text">
        <span className="chat-tool-name">{status}</span>
        <span className="chat-tool-summary">{subject}</span>
        {!question && <PermissionLevelTag request={request} />}
        {answers && question && !hosted && (
          <span className="chat-permission-row-answer">→ {answers}</span>
        )}
        {entry.answers && question && hosted && (
          <AnswerList request={request} answers={entry.answers} />
        )}
      </span>
    </div>
  )
}

/** A run of approvals the reader allowed: one row, led by the shield, that
 *  opens to one receipt per request. An uncontrolled `<details>` keyed by the
 *  row's key, as a run of tools is: the reader's choice is DOM state
 *  a re-render cannot touch, and a receipt arriving mid-run neither closes an
 *  opened row nor opens a closed one. */
export function ApprovalRun({
  group,
  id
}: {
  group: ApprovalGroup
  /** The row's key (`blockKey`): what the reader's disclosure is remembered under. */
  id: string
}): React.JSX.Element {
  const disclosure = useDisclosure(id)
  const [opened, setOpened] = useState(disclosure.initial)
  const { head, detail } = approvalRunSummary(group.approvals)
  return (
    <details
      className="chat-approval-run"
      data-count={group.approvals.length}
      open={disclosure.initial}
      onToggle={(event) => {
        if (disclosure.toggle(event)) setOpened(true)
      }}
    >
      <summary className="chat-tool-row">
        <ShieldCheckIcon className="chat-tool-status" aria-label="Allowed" />
        <span className="chat-tool-run-summary">
          <span className="chat-tool-name">{head}</span>
          {detail && <span className="chat-tool-summary">{detail}</span>}
        </span>
        <ChevronRightIcon className="chat-tool-chevron" />
      </summary>
      {opened && (
        <div className="chat-approval-items">
          {group.approvals.map((entry) => (
            <PermissionRow key={entry.request.id} entry={entry} />
          ))}
        </div>
      )}
    </details>
  )
}
