import { useMemo, useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@clave/ui/components'
import { claudeModelName } from '../../../src/shared/claude-models'
import type { Conversation } from './reducer'
import { groupEntries, visibleEntries } from './tools'
import { EntryRow, ToolRow } from './TerminalEntry'
import { ToolDisclosure } from './disclosure'
import { useTranscriptEnd } from './transcript'
import { compactTokens, type SubAgent } from './terminal-status'
import { AgentModel } from './AgentModel'

/** How close to the end still counts as there, for the follow. */
const SLACK = 48

/* A window onto a subagent: what it was asked, what it says and what it
   does, as it happens, rendered the way the transcript renders the
   conversation (`TerminalEntry`). A view only: there is no composer, no
   button answers anything, and the agent reports to the conversation when
   it is done, not to this box. It opens from the agent's row in the status
   stack, on top of it, follows the agent's work while the reader is at its
   end and leaves a reader who scrolled up where they are; it closes on
   Escape, on a click outside, and with its row when the agent ends. */
export function SubAgentPeek({
  agent,
  log,
  onRelaunch,
  children
}: {
  agent: SubAgent
  /** The agent's own conversation, when anything of it has reached this view. */
  log: Conversation | undefined
  /** Relaunch the agent on another model, when it can be (asks first). */
  onRelaunch?: (alias: string) => void
  /** The row, which is the trigger. */
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="term-peek"
        aria-label={`What ${agent.description || agent.type} is doing`}
        // The box is a window, not a form: nothing in it takes the caret
        // from the composer when it opens.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {open && <PeekBody agent={agent} log={log} onRelaunch={onRelaunch} />}
      </PopoverContent>
    </Popover>
  )
}

function PeekBody({
  agent,
  log,
  onRelaunch
}: {
  agent: SubAgent
  log: Conversation | undefined
  onRelaunch?: (alias: string) => void
}): React.JSX.Element {
  const entries = log?.entries
  const blocks = useMemo(() => (entries ? groupEntries(visibleEntries(entries)) : []), [entries])
  // The reader's open tool rows in this box, its own memory: a run opened
  // here is not one opened in the transcript.
  const [disclosure] = useState(() => new Map<string, boolean>())
  const { scroll } = useTranscriptEnd(entries, () => SLACK)
  const model = claudeModelName(agent.model) ?? agent.model
  // The last run is the one in flight while the agent runs; a finished
  // agent's calls are done, result or not.
  const liveRun = blocks.findLast((block) => block.kind === 'tool-group')
  return (
    <div className="term-peek-frame">
      <header className="term-peek-head">
        <span className="term-peek-type">{agent.type}</span>
        <span className="term-peek-description" title={agent.description}>
          {agent.description}
        </span>
        <span className="term-peek-meta">
          {model && <AgentModel agent={agent} onPick={onRelaunch} />}
          {agent.toolCount > 0 && (
            <span>{`${agent.toolCount} step${agent.toolCount === 1 ? '' : 's'}`}</span>
          )}
          {agent.contextUsed !== null && (
            <span title="Tokens in this agent's own context">
              {compactTokens(agent.contextUsed)} ctx
            </span>
          )}
        </span>
      </header>
      <div className="term-peek-scroll chat-scroll" ref={scroll}>
        {blocks.length === 0 ? (
          <p className="term-peek-empty">
            Nothing from it yet: its brief, its words and its tool runs appear here as they reach
            this window.
          </p>
        ) : (
          <ToolDisclosure.Provider value={disclosure}>
            <section className="term-turn term-peek-body">
              {blocks.map((block, index) =>
                block.kind === 'tool-group' ? (
                  <ToolRow key={block.id} group={block} live={block === liveRun} />
                ) : block.kind === 'approval-group' || block.kind === 'delivery-group' ? null : (
                  <EntryRow key={`${index}-${block.at}`} entry={block} onError={console.error} />
                )
              )}
            </section>
          </ToolDisclosure.Provider>
        )}
      </div>
    </div>
  )
}
