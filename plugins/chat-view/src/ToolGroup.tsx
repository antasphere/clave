import { useState } from 'react'
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon
} from '@heroicons/react/24/outline'
import {
  describeTool,
  failureCount,
  groupStatus,
  toolGroupSummary,
  toolPreview,
  safeJson,
  type GroupStatus,
  type Section,
  type ToolEntry,
  type ToolGroup as Group
} from './tools'

const stringify = (value: unknown): string => (typeof value === 'string' ? value : safeJson(value))

function StatusIcon({ status }: { status: GroupStatus }): React.JSX.Element {
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
  return <CheckIcon className="chat-tool-status" aria-label="Complete" />
}

/** A preview shows the first lines; the rest is one click away, per section,
 *  so opening a group never dumps a megabyte of output into the column. */
function Preview({ label, text }: Section): React.JSX.Element {
  const [full, setFull] = useState(false)
  const preview = toolPreview(text)
  return (
    <div className="chat-tool-section">
      <div className="chat-card-label">{label}</div>
      <pre>{full ? text : preview.text}</pre>
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

function ToolItem({ tool }: { tool: ToolEntry }): React.JSX.Element {
  const description = describeTool(tool)
  const status: GroupStatus = !tool.complete ? 'running' : tool.failed ? 'failed' : 'complete'
  return (
    <section
      className="chat-tool-item"
      data-state={status}
      aria-label={`${description.label}${description.target ? ` ${description.target}` : ''}`}
    >
      <div className="chat-tool-item-head">
        <StatusIcon status={status} />
        <span className="chat-tool-name">{description.label}</span>
        {description.target && (
          <span className="chat-tool-summary" title={description.target}>
            {description.target}
          </span>
        )}
        {description.detail && <span className="chat-tool-detail">{description.detail}</span>}
      </div>
      {description.sections.map((section, index) => (
        <Preview key={index} {...section} />
      ))}
      {!description.sections.length && (
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
    </section>
  )
}

/** One row for a whole run of tools. It is an uncontrolled `<details>` on
 *  purpose, keyed by the run's first tool id: the reader's choice is DOM state
 *  that a re-render cannot touch, so a result arriving mid-run neither closes an
 *  opened row nor opens a closed one — and a failure, having no way to set
 *  `open`, can never expand the row by itself. */
export function ToolGroup({ group }: { group: Group }): React.JSX.Element {
  const status = groupStatus(group.tools)
  const failures = failureCount(group.tools)
  const summary = toolGroupSummary(group.tools)
  /* The bodies are built only once the reader has opened the row, and stay built
     after: a closed run of big outputs otherwise puts every byte in the document
     TWICE per tool, the preview and the raw block. It does NOT save the
     derivation — a closed row still summarises itself on every render — which is
     why the summary reads `describeToolHead` and never turns an output into
     text. This reads `open` rather than setting it, so the row stays
     uncontrolled and nothing here can expand it. */
  const [opened, setOpened] = useState(false)
  return (
    <details
      className="chat-tool-card chat-tool-run"
      data-state={status}
      data-failures={failures}
      data-tools={group.tools.length}
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true)
      }}
    >
      <summary>
        <ChevronRightIcon className="chat-tool-chevron" />
        <StatusIcon status={status} />
        <span className="chat-tool-run-summary" title={summary}>
          {summary}
        </span>
        {failures > 0 && <span className="chat-tool-failures">{failures} failed</span>}
      </summary>
      <div className="chat-card-body">
        {opened && group.tools.map((tool) => <ToolItem key={tool.id} tool={tool} />)}
      </div>
    </details>
  )
}
