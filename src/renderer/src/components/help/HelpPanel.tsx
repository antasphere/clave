import { useState, useMemo, type ReactNode } from 'react'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { MarkdownRenderer } from '../files/MarkdownRenderer'
import helpIndex from '../../help/index.json'

import gettingStarted from '../../help/getting-started.md?raw'
import sessions from '../../help/sessions.md?raw'
import git from '../../help/git.md?raw'
import groups from '../../help/groups.md?raw'
import files from '../../help/files.md?raw'
import workTracker from '../../help/work-tracker.md?raw'
import usage from '../../help/usage.md?raw'
import shortcuts from '../../help/shortcuts.md?raw'
import remote from '../../help/remote.md?raw'
import settings from '../../help/settings.md?raw'

const helpDocsMap: Record<string, string> = {
  'getting-started': gettingStarted,
  sessions,
  git,
  groups,
  files,
  'work-tracker': workTracker,
  usage,
  shortcuts,
  remote,
  settings
}

function getDocContent(id: string): string | null {
  return helpDocsMap[id] ?? null
}

interface HelpEntry {
  id: string
  title: string
  subtitle: string
  keywords: string[]
}

export function HelpPanel(): ReactNode {
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')

  const filteredDocs = useMemo(() => {
    if (!filterText) return helpIndex as HelpEntry[]
    const lower = filterText.toLowerCase()
    return (helpIndex as HelpEntry[]).filter(
      (doc) =>
        doc.title.toLowerCase().includes(lower) ||
        doc.subtitle.toLowerCase().includes(lower) ||
        doc.keywords.some((k) => k.includes(lower))
    )
  }, [filterText])

  const selectedDoc = selectedDocId ? getDocContent(selectedDocId) : null
  const selectedTitle = selectedDocId
    ? (helpIndex as HelpEntry[]).find((d) => d.id === selectedDocId)?.title
    : null

  if (selectedDocId && selectedDoc !== null) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle flex-shrink-0">
          <button
            onClick={() => setSelectedDocId(null)}
            className="btn-icon btn-icon-xs"
          >
            <ArrowLeftIcon className="w-4 h-4" />
          </button>
          <span className="text-xs font-medium text-text-primary truncate">{selectedTitle}</span>
        </div>
        <div className="flex-1 overflow-y-auto pb-12">
          <MarkdownRenderer content={selectedDoc} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle flex-shrink-0">
        <input
          type="text"
          placeholder="Search help..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="flex-1 h-control-xs px-2 rounded bg-surface-100 text-[11px] text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-border transition-colors min-w-0"
        />
      </div>
      <div className="flex-1 overflow-y-auto pb-12">
        {filteredDocs.map((doc) => (
          <button
            key={doc.id}
            onClick={() => setSelectedDocId(doc.id)}
            className="w-full text-left px-3 py-2.5 hover:bg-surface-100 transition-colors border-b border-border-subtle"
          >
            <div className="text-xs font-medium text-text-primary">{doc.title}</div>
            <div className="text-[11px] text-text-tertiary mt-0.5">{doc.subtitle}</div>
          </button>
        ))}
        {filteredDocs.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
            No matching docs
          </div>
        )}
      </div>
    </div>
  )
}
