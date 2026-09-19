import { useState } from 'react'
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon
} from '@heroicons/react/24/outline'
import type { ConversationTool } from '../../../../shared/agent-session'
import { describeTool, toolGroupSummary, toolPreview } from '../../lib/conversation-tools'
import { PluginEntryView } from './PluginEntryView'

function ToolStatus({ status }: { status: ConversationTool['status'] }): React.JSX.Element {
  const Icon =
    status === 'running' ? ArrowPathIcon : status === 'failed' ? ExclamationTriangleIcon : CheckIcon
  return (
    <Icon
      aria-label={status}
      className={`w-4 h-4 ${status === 'running' ? 'conversation-working' : ''}`}
    />
  )
}

function Preview({ label, text }: { label: string; text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const preview = toolPreview(text)
  return (
    <section className="conversation-tool-preview" aria-label={label}>
      <h4>{label}</h4>
      <pre>{expanded ? text : preview.text}</pre>
      {preview.truncated && (
        <button
          type="button"
          className="btn-secondary"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  )
}

function ToolDetails({ tool }: { tool: ConversationTool }): React.JSX.Element {
  const description = describeTool(tool)
  return (
    <section
      className="conversation-tool-item"
      data-state={tool.status}
      aria-label={`${description.label} ${description.target}`}
    >
      <div className="conversation-tool-heading">
        <ToolStatus status={tool.status} />
        <span title={description.target}>
          {description.label}
          {description.target && ` · ${description.target}`}
        </span>
      </div>
      {description.detail && <p className="conversation-tool-meta">{description.detail}</p>}
      {description.sections.map((section, index) => (
        <Preview key={index} {...section} />
      ))}
      {!description.sections.length && (
        <p className="conversation-tool-meta">
          {tool.status === 'running' ? 'Waiting for output…' : 'No output returned.'}
        </p>
      )}
      <details className="conversation-tool-raw">
        <summary>Raw details</summary>
        <h4>Input</h4>
        <pre>{tool.input || 'No input recorded.'}</pre>
        <h4>Output</h4>
        <pre>{tool.output || 'No output recorded.'}</pre>
      </details>
    </section>
  )
}

export function ConversationToolGroup({
  tools,
  sessionId,
  onInspect
}: {
  tools: ConversationTool[]
  sessionId: string
  onInspect: () => void
}): React.JSX.Element {
  const running = tools.some((tool) => tool.status === 'running')
  const failed = tools.some((tool) => tool.status === 'failed')
  const status = running ? 'running' : failed ? 'failed' : 'completed'
  const summary = toolGroupSummary(tools)
  return (
    <details
      className="conversation-tool conversation-tool-group"
      data-state={failed ? 'failed' : status}
    >
      <summary title={summary} onClick={onInspect}>
        <ToolStatus status={status} />
        <span>{summary}</span>
        {failed && running && <ExclamationTriangleIcon aria-label="failed" className="w-4 h-4" />}
        <ChevronRightIcon className="conversation-chevron w-4 h-4" />
      </summary>
      <div className="conversation-tool-body">
        {tools.map((tool) => (
          <PluginEntryView key={tool.id} sessionId={sessionId} entry={tool}>
            <ToolDetails tool={tool} />
          </PluginEntryView>
        ))}
      </div>
    </details>
  )
}
