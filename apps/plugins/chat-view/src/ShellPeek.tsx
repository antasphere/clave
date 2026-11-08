import { useEffect, useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@clave/ui/components'
import { useTranscriptEnd } from './transcript'
import type { SubAgent } from './terminal-status'

/** How often the output is read again while the window is open. */
const POLL_MS = 1000
/** How close to the end still counts as there, for the follow. */
const SLACK = 32

/* A window onto a command left running: its title and its full command line
   at the head, and what it has written so far below, read again every
   second from the file the provider names (Claude writes a background
   command's output to a file of its own; Codex names none, and hands the
   output to the transcript when the command completes). A view only, as the
   subagent's window is: it follows the output while the reader is at its
   end and leaves a reader who scrolled up where they are. */
export function ShellPeek({
  agent,
  children
}: {
  agent: SubAgent
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
        aria-label={`Output of ${agent.description}`}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {open && <ShellBody agent={agent} />}
      </PopoverContent>
    </Popover>
  )
}

type Read =
  | { state: 'reading' }
  | { state: 'read'; content: string; truncated: boolean }
  | { state: 'failed' }

function ShellBody({ agent }: { agent: SubAgent }): React.JSX.Element {
  const file = agent.outputFile
  // The read is rooted on the file's own folder: the provider writes it
  // outside the session's folder (Claude: under its own temp directory).
  const root = file ? file.slice(0, file.lastIndexOf('/')) || '/' : ''
  const [read, setRead] = useState<Read>({ state: 'reading' })
  useEffect(() => {
    if (!file) return
    let live = true
    const once = (): void => {
      void window.electronAPI
        .readFile(root, file)
        .then((result) => {
          if (live) setRead({ state: 'read', content: result.content, truncated: result.truncated })
        })
        .catch(() => {
          if (live) setRead({ state: 'failed' })
        })
    }
    once()
    const timer = window.setInterval(once, POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [root, file])
  const content = read.state === 'read' ? read.content : ''
  const { scroll } = useTranscriptEnd(content, () => SLACK)
  return (
    <div className="term-peek-frame">
      <header className="term-peek-head">
        <span className="term-peek-description" title={agent.description}>
          {agent.description}
        </span>
        <span className="term-peek-meta">
          <span>{agent.background ? 'in the background' : 'running'}</span>
        </span>
      </header>
      {agent.command && agent.command !== agent.description && (
        <code className="term-peek-command" title={agent.command}>
          {agent.command}
        </code>
      )}
      <div className="term-peek-scroll chat-scroll" ref={scroll}>
        {!file ? (
          <p className="term-peek-empty">
            Its output arrives when it completes, in the transcript: the provider names no file to
            read it from while it runs.
          </p>
        ) : read.state === 'failed' ? (
          <p className="term-peek-empty">
            Its output cannot be read from here: the file is gone, or the command runs on another
            machine.
          </p>
        ) : read.state === 'reading' ? (
          <p className="term-peek-empty">Reading…</p>
        ) : content.trim() === '' ? (
          <p className="term-peek-empty">Nothing written yet.</p>
        ) : (
          <pre className="term-shell-output">
            {content}
            {read.truncated && '\n… (the file is longer than this window reads)'}
          </pre>
        )}
      </div>
    </div>
  )
}
