import { useState } from 'react'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { ToolPanel } from './ToolGroup'
import { KIND_ICONS } from './tool-icons'
import { useDisclosure } from './disclosure'
import {
  describeToolHead,
  failureCount,
  runTitle,
  toolVerb,
  type ToolEntry,
  type ToolGroup as Group
} from './tools'

/* The Terminal view's run of tool calls. Two levels, never mixed:
   - the RUN is a title, one sentence counting what was done ("Read 2 files,
     ran 1 command"), whether the run holds one call or ten. It carries no kind
     icon, only the chevron that opens it: a run of mixed calls has no one kind.
   - each CALL is a row inside it, indented under the title, led by the icon of
     its kind, opening to its panel.
   A call in flight never swaps its icon for a spinner (the swap was the
   flicker between two glyphs): the words shimmer instead, the title's and the
   call's, and the title names what it is waiting on.

   A call is only in flight while its turn is: `live` is the view's word that
   this run belongs to the turn the agent is working on now. A call left
   without a result by an interrupted or finished turn, or read back from the
   past without one, is not running; it says it got no result. */

type CallState = 'running' | 'failed' | 'complete' | 'stopped'
const callState = (tool: ToolEntry, live: boolean): CallState =>
  !tool.complete ? (live ? 'running' : 'stopped') : tool.failed ? 'failed' : 'complete'

function CallLine({ tool }: { tool: ToolEntry }): React.JSX.Element {
  const { kind, label, target } = describeToolHead(tool)
  return (
    <>
      <span className="term-call-verb">{toolVerb(kind, label)}</span>
      {target && <span className="term-call-target">{target.split('\n')[0]}</span>}
    </>
  )
}

/** What a call in flight acts on, for the run's title: its target's first
 *  line, or its verb when it names none. */
const nowTarget = (tool: ToolEntry): string => {
  const { kind, label, target } = describeToolHead(tool)
  return target ? target.split('\n')[0] : toolVerb(kind, label)
}

/** One call: its kind's icon, what it did, and its panel when opened. The
 *  panel is built on approach (hover or focus), so it is there to open into
 *  and the opening can animate to its real height. */
function Call({ tool, live }: { tool: ToolEntry; live: boolean }): React.JSX.Element {
  // Rows are virtualised: a call the reader opened comes back open (disclosure.ts).
  const disclosure = useDisclosure(`tool-${tool.id}`)
  const [built, setBuilt] = useState(disclosure.initial)
  const state = callState(tool, live)
  const Icon = KIND_ICONS[describeToolHead(tool).kind]
  const build = (): void => setBuilt(true)
  return (
    <details
      className="term-call"
      data-state={state}
      open={disclosure.initial}
      onToggle={(event) => {
        if (disclosure.toggle(event)) setBuilt(true)
      }}
    >
      <summary className="term-call-row" onPointerEnter={build} onFocus={build}>
        <Icon className="term-call-icon" aria-hidden="true" />
        <span className="term-call-text">
          <CallLine tool={tool} />
        </span>
        {state === 'failed' && <span className="term-call-note">failed</span>}
        {state === 'stopped' && <span className="term-call-note">no result</span>}
        <ChevronRightIcon className="term-call-chevron" aria-hidden="true" />
      </summary>
      <div className="term-call-body">{built && <ToolPanel tool={tool} />}</div>
    </details>
  )
}

/** One run. An uncontrolled `<details>`, keyed by the run's first call id
 *  (TerminalView), so a result arriving never opens or closes it; the one
 *  value it is given is the reader's own choice from before the row was last
 *  unmounted (disclosure.ts). Its calls
 *  are only rows, cheap to render closed; each call's panel waits for the
 *  reader. */
export function TerminalTools({ group, live }: { group: Group; live: boolean }): React.JSX.Element {
  const disclosure = useDisclosure(`run-${group.id}`)
  const running = live ? group.tools.find((tool) => !tool.complete) : undefined
  const failures = failureCount(group.tools)
  return (
    <details
      className="term-tools"
      data-state={running ? 'running' : failures ? 'failed' : 'complete'}
      data-tools={group.tools.length}
      open={disclosure.initial}
      onToggle={disclosure.toggle}
    >
      <summary className="term-tools-row">
        <ChevronRightIcon className="term-tools-chevron" aria-hidden="true" />
        <span className="term-tools-title">{runTitle(group.tools)}</span>
        {failures > 0 && <span className="term-tools-failed">{failures} failed</span>}
        {running && (
          // The title already says the kind of work; this is only its object.
          <span className="term-tools-now" aria-live="polite">
            <span className="term-call-target">{nowTarget(running)}</span>
          </span>
        )}
      </summary>
      <div className="term-tools-body">
        {group.tools.map((tool) => (
          <Call key={tool.id} tool={tool} live={live} />
        ))}
      </div>
    </details>
  )
}
