import { useState } from 'react'
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon
} from '@heroicons/react/24/outline'
import { Tooltip, TooltipContent, TooltipTrigger } from '@clave/ui/components'
import {
  describeTool,
  describeToolHead,
  failureCount,
  groupHint,
  groupKind,
  groupStatus,
  sectionLanguage,
  toolGroupSummary,
  toolHint,
  toolPreview,
  toolVerb,
  safeJson,
  type GroupStatus,
  type Section,
  type ToolEntry,
  type ToolKind,
  type ToolGroup as Group
} from './tools'
import { ChatCode } from './code'
import { useDisclosure } from './disclosure'
import { KIND_ICONS } from './tool-icons'

const stringify = (value: unknown): string => (typeof value === 'string' ? value : safeJson(value))

/** The glyph a row opens with: what kind of call it was, until something is
 *  still running (a spinner) or failed (the warning), which the reader needs
 *  more than the kind. It carries the status label either way. */
function RowIcon({ kind, status }: { kind: ToolKind; status: GroupStatus }): React.JSX.Element {
  if (status === 'running')
    return <ArrowPathIcon className="chat-tool-status" data-running="true" aria-label="Running" />
  if (status === 'failed')
    return (
      <ExclamationTriangleIcon
        className="chat-tool-status"
        data-failed="true"
        aria-label="Failed"
      />
    )
  const Icon = KIND_ICONS[kind]
  return <Icon className="chat-tool-status" aria-label="Complete" />
}

/** A row's summary line: icon, what was done, and the chevron that shows on
 *  approach. The hover names the kind of call in a few words. */
function RowSummary({
  kind,
  status,
  hint,
  children
}: {
  kind: ToolKind
  status: GroupStatus
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  // A label, not a surface: it closes as the pointer leaves the row, so moving
  // on to the next row names that one instead of keeping this one open.
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <summary className="chat-tool-row">
          <RowIcon kind={kind} status={status} />
          {children}
          <ChevronRightIcon className="chat-tool-chevron" />
        </summary>
      </TooltipTrigger>
      <TooltipContent side="right">{hint}</TooltipContent>
    </Tooltip>
  )
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="chat-turn-copy"
      data-copied={copied ? 'true' : undefined}
      aria-label="Copy"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
    </button>
  )
}

/** A preview shows the first lines; the rest is one click away, per section,
 *  so opening a call never dumps a megabyte of output into the column. */
function Preview({
  section,
  language,
  prompt
}: {
  section: Section
  language?: string
  prompt?: boolean
}): React.JSX.Element {
  const [full, setFull] = useState(false)
  const preview = toolPreview(section.text)
  const text = full ? section.text : preview.text
  return (
    <div className="chat-tool-section" data-label={section.label}>
      <pre>
        {prompt && <span className="chat-tool-prompt">$ </span>}
        <ChatCode className={language ? `language-${language}` : undefined}>{text}</ChatCode>
      </pre>
      {preview.truncated && (
        <button
          type="button"
          className="chat-tool-more"
          aria-expanded={full}
          onClick={() => setFull(!full)}
        >
          {full ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** What one call actually did, the atomic view: a framed panel headed by its
 *  kind, the command or target as code, then what came back. */
export function ToolPanel({ tool }: { tool: ToolEntry }): React.JSX.Element {
  const description = describeTool(tool)
  const { kind, target } = description
  const sections =
    kind === 'command'
      ? description.sections.filter((s) => s.label !== 'Command')
      : description.sections
  const copyText = [kind === 'command' ? `$ ${target}` : '', ...sections.map((s) => s.text)]
    .filter(Boolean)
    .join('\n\n')
  return (
    <div className="chat-tool-panel">
      <div className="chat-tool-panel-head">
        <span>{description.label}</span>
        {description.detail && <span className="chat-tool-detail">{description.detail}</span>}
        {copyText && <CopyButton text={copyText} />}
      </div>
      {kind === 'command' && target && (
        <Preview section={{ label: 'Command', text: target }} language="bash" prompt />
      )}
      {sections.map((section, index) => (
        <Preview key={index} section={section} language={sectionLanguage(kind, section, target)} />
      ))}
      {!sections.length && (
        <div className="chat-tool-detail">
          {tool.complete ? 'No output returned.' : 'Waiting for output…'}
        </div>
      )}
      <details className="chat-tool-raw">
        <summary>Raw input and output</summary>
        <div className="chat-tool-section">
          <div className="chat-card-label">Input</div>
          <pre>{tool.input === undefined ? 'No input recorded.' : stringify(tool.input)}</pre>
          <div className="chat-card-label">Output</div>
          <pre>
            {!tool.complete
              ? 'Not finished.'
              : tool.output === undefined
                ? 'No output recorded.'
                : stringify(tool.output)}
          </pre>
        </div>
      </details>
    </div>
  )
}

const toolStatus = (tool: ToolEntry): GroupStatus =>
  !tool.complete ? 'running' : tool.failed ? 'failed' : 'complete'

/** What a call's row reads: its verb, then the target it acted on. */
function ToolLine({ tool }: { tool: ToolEntry }): React.JSX.Element {
  const { kind, label, target } = describeToolHead(tool)
  return (
    <span className="chat-tool-line">
      <span className="chat-tool-name">{toolVerb(kind, label)}</span>
      {target && <span className="chat-tool-summary">{target.split('\n')[0]}</span>}
    </span>
  )
}

/** One call inside an opened run: a row of its own that opens to the panel.
 *  Uncontrolled and built on first open, for the same reasons as the run. */
function ToolItem({ tool }: { tool: ToolEntry }): React.JSX.Element {
  const disclosure = useDisclosure(`tool-${tool.id}`)
  const [opened, setOpened] = useState(disclosure.initial)
  const status = toolStatus(tool)
  return (
    <details
      className="chat-tool-item"
      data-state={status}
      open={disclosure.initial}
      onToggle={(event) => {
        if (disclosure.toggle(event)) setOpened(true)
      }}
    >
      <RowSummary kind={describeToolHead(tool).kind} status={status} hint={toolHint(tool)}>
        <ToolLine tool={tool} />
      </RowSummary>
      {opened && <ToolPanel tool={tool} />}
    </details>
  )
}

/** One row for a whole run of tools. It is an uncontrolled `<details>` on
 *  purpose, keyed by the run's first tool id: the reader's choice is DOM state
 *  that a re-render cannot touch, so a result arriving mid-run neither closes an
 *  opened row nor opens a closed one — and a failure, having no way to set
 *  `open`, can never expand the row by itself. A lone call is its own row and
 *  opens straight to its panel; a run of several opens to one row per call. */
export function ToolGroup({ group }: { group: Group }): React.JSX.Element {
  const status = groupStatus(group.tools)
  const failures = failureCount(group.tools)
  const lone = group.tools.length === 1 ? group.tools[0] : undefined
  const summary = lone ? '' : toolGroupSummary(group.tools)
  /* The bodies are built only once the reader has opened the row, and stay built
     after: a closed run of big outputs otherwise puts every byte in the document.
     The summary reads `describeToolHead` and never turns an output into text.
     This reads `open` rather than setting it, so the row stays uncontrolled;
     the one value it passes is the reader's own choice from before the row was
     last unmounted, fixed at mount (`ToolDisclosure`). */
  const disclosure = useDisclosure(`run-${group.id}`)
  const [opened, setOpened] = useState(disclosure.initial)
  return (
    <details
      className="chat-tool-run"
      data-state={status}
      data-failures={failures}
      data-tools={group.tools.length}
      open={disclosure.initial}
      onToggle={(event) => {
        if (disclosure.toggle(event)) setOpened(true)
      }}
    >
      <RowSummary kind={groupKind(group.tools)} status={status} hint={groupHint(group.tools)}>
        {lone ? (
          <span className="chat-tool-run-summary">
            <ToolLine tool={lone} />
          </span>
        ) : (
          <span className="chat-tool-run-summary">{summary}</span>
        )}
        {failures > 0 && <span className="chat-tool-failures">{failures} failed</span>}
      </RowSummary>
      {opened &&
        (lone ? (
          <div className="chat-tool-item" data-lone="true">
            <ToolPanel tool={lone} />
          </div>
        ) : (
          <div className="chat-tool-items">
            {group.tools.map((tool) => (
              <ToolItem key={tool.id} tool={tool} />
            ))}
          </div>
        ))}
    </details>
  )
}
