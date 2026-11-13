import { useCallback, useEffect, useState } from 'react'
import * as DropdownMenu from '@clave/ui/primitives/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import type { ArtefactVersions } from '@clave/contract/artefacts/model'
import { useArtefactStore } from '../../store/artefact-store'
import { versionLabel } from '../../lib/artefact-version'

/** A version's time, short enough to sit on its row: 13 Nov 11:58. */
const when = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = date.toLocaleDateString([], { day: 'numeric', month: 'short' })
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

/**
 * The version an artefact's panel shows, in its bar (PRDCT-4494): the live
 * folder, the latest version, or one version, chosen from the list the
 * server's preview keeps. It replaces Slideless's own bar, hidden in the
 * frame; the list is read again each time the menu opens and after a save.
 */
export function ArtefactVersionChip({ sessionId }: { sessionId: string }): React.JSX.Element {
  const shown = useArtefactStore((s) => s.version[sessionId] ?? 'live')
  const setVersion = useArtefactStore((s) => s.setVersion)
  const saved = useArtefactStore((s) => s.versionsSaved[sessionId] ?? 0)
  const [open, setOpen] = useState(false)
  const [listed, setListed] = useState<ArtefactVersions | null>(null)
  const read = useCallback(() => {
    window.electronAPI.artefacts
      .versions(sessionId)
      .then(setListed, (error: unknown) =>
        setListed({ versions: [], error: error instanceof Error ? error.message : String(error) })
      )
  }, [sessionId])
  useEffect(() => read(), [read, saved])
  const versions = listed?.versions ?? []
  const latest = versions.at(-1)?.version
  const choose = (next: string): void => setVersion(sessionId, next)
  const row = (value: string, label: string, hint: string): React.JSX.Element => (
    <DropdownMenu.Item
      key={value}
      className="menu-item"
      data-selected={value === shown ? 'true' : undefined}
      data-version={value}
      onSelect={() => choose(value)}
    >
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="menu-hint whitespace-nowrap">{hint}</span>}
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) read()
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="artefact-version-chip"
          aria-label="Version shown"
          title="What the panel shows"
          data-version={shown}
          data-pinned={shown === 'live' ? undefined : 'true'}
        >
          <span>{versionLabel(shown)}</span>
          <ChevronDownIcon className="w-3 h-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="menu-surface menu-pop z-50 min-w-[18rem] max-h-[60vh] overflow-auto p-1"
          aria-label="Versions"
        >
          <DropdownMenu.Label className="menu-label">Show</DropdownMenu.Label>
          {row('live', 'Live', 'the working folder')}
          {!listed?.error &&
            row('latest', 'Latest version', latest ? `v${latest}` : 'none saved yet')}
          {versions.length > 0 && <DropdownMenu.Separator className="menu-sep" />}
          {[...versions]
            .reverse()
            .map((v) =>
              row(
                String(v.version),
                `v${v.version}`,
                `${when(v.createdAt)} · ${v.fileCount} ${v.fileCount === 1 ? 'file' : 'files'}`
              )
            )}
          {listed?.error && (
            <p className="menu-hint px-2 py-1.5" role="status">
              Versions unavailable: {listed.error}
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
