import * as DropdownMenu from '@clave/ui/primitives/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import type { Artefact } from '@clave/contract/artefacts/model'
import { useArtefactStore } from '../../store/artefact-store'
import { shortTime } from '../../lib/artefact-version'

/**
 * The artefact panel's title, and the picker of the session's artefacts
 * when it keeps several (PRDCT-5022): the newest first, each with the time
 * it was opened. The pick is the window's, kept until the agent opens
 * another page, which then shows.
 */
export function ArtefactPicker({
  sessionId,
  artefact
}: {
  sessionId: string
  /** The artefact the panel shows. */
  artefact: Artefact
}): React.JSX.Element {
  const list = useArtefactStore((s) => s.lists[sessionId])
  const pick = useArtefactStore((s) => s.pick)
  if (!list || list.length < 2) return <span className="pane-header-title">{artefact.title}</span>
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="artefact-picker"
          aria-label="Artefact shown"
          title="Which of the session's pages the panel shows"
        >
          <span className="pane-header-title">{artefact.title}</span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="menu-surface menu-pop z-50 min-w-[16rem] max-h-[60vh] overflow-auto p-1"
          aria-label="Artefacts"
        >
          <DropdownMenu.Label className="menu-label">Show</DropdownMenu.Label>
          {[...list].reverse().map((a) => (
            <DropdownMenu.Item
              key={a.target}
              className="menu-item"
              data-selected={a.target === artefact.target ? 'true' : undefined}
              data-target={a.target}
              title={a.page}
              onSelect={() => pick(sessionId, a.target)}
            >
              <span className="flex-1 truncate">{a.title}</span>
              <span className="menu-hint whitespace-nowrap">{shortTime(a.openedAt)}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
