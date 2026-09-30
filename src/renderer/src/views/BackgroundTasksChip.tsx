import { useEffect, useState } from 'react'
import {
  CommandLineIcon,
  CpuChipIcon,
  DocumentTextIcon,
  QueueListIcon
} from '@heroicons/react/24/outline'
import { Popover, PopoverContent, PopoverTrigger } from '@clave/ui/components'
import type { BackgroundTask } from '../../../shared/session-model'
import { useSessionStore } from '../store/session-store'

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function openOutput(file: string): void {
  useSessionStore.getState().addFileTab({
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    filePath: file,
    name: file.split('/').pop() ?? file
  })
}

function TaskRow({ task, now }: { task: BackgroundTask; now: number }): React.JSX.Element {
  const Icon =
    task.kind === 'agent' ? CpuChipIcon : task.kind === 'shell' ? CommandLineIcon : QueueListIcon
  const kind = task.kind === 'agent' ? 'Subagent' : task.kind === 'shell' ? 'Shell' : 'Task'
  return (
    <li className="background-task" data-kind={task.kind}>
      <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-label={kind} />
      <span className="background-task-name" title={task.description}>
        {task.description}
      </span>
      <span className="background-task-time">{elapsed(task.startedAt, now)}</span>
      {task.outputFile && (
        <button
          className="panel-icon-btn"
          title={`View output: ${task.outputFile}`}
          aria-label={`View output of ${task.description}`}
          onClick={() => openOutput(task.outputFile!)}
        >
          <DocumentTextIcon className="w-3.5 h-3.5" />
        </button>
      )}
    </li>
  )
}

/**
 * The header's word that work goes on after the turn: background shells and
 * subagents the agent left running. The turn's own state says `done` while
 * these run, and a chat session has no terminal to show them otherwise. The
 * list is the provider's own, whole, so a task leaves it when the CLI says it
 * ended — never kept "running" by this view.
 */
export function BackgroundTasksChip({
  tasks
}: {
  tasks: BackgroundTask[]
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // The timers only tick where someone reads them.
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])
  if (!tasks.length) return null
  const label = `${tasks.length} in background`
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setNow(Date.now())
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          className="panel-tab background-tasks-chip"
          aria-label={label}
          title="Work still running after the turn"
        >
          <span className="background-tasks-pulse" aria-hidden />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        animated
        open={open}
        side="bottom"
        align="end"
        sideOffset={6}
        className="background-tasks-popover"
      >
        <div className="menu-label">Running in the background</div>
        <ul className="background-task-list">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} now={now} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
