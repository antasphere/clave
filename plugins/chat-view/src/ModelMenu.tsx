import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import type { ModelOption } from '../../../src/shared/session-model'
import { currentOption, modelChipLabel } from './models'

/** The model chip on the composer's footer and the menu it opens above it. */
export function ModelMenu({
  sessionId,
  model,
  disabled,
  onSelect
}: {
  sessionId: string
  model: string | null
  disabled: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    // A host older than this plugin has no sessionsModels: that is the menu's
    // failure to report, never the pane's to crash on, so the call is made
    // inside the chain where a missing method rejects instead of throwing.
    Promise.resolve()
      .then(() => window.electronAPI.sessionsModels(sessionId))
      .then((list) => {
        if (live) setOptions(list)
      })
      .catch((error) => {
        if (live) setFailure(String(error))
      })
    return () => {
      live = false
    }
  }, [open, sessionId])
  const current = currentOption(model, options)
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        // Each opening asks the provider again, from a clean slate.
        if (next) setFailure(null)
        setOpen(next)
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger"
          aria-label="Model"
          title="Change model"
          disabled={disabled}
        >
          <span className="chat-model-trigger-label">{modelChipLabel(model, options)}</span>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Models"
        >
          <DropdownMenu.Label className="menu-label">Select model</DropdownMenu.Label>
          {options === null && !failure && <div className="chat-model-empty">Loading…</div>}
          {failure && <div className="chat-model-empty">Models unavailable</div>}
          {options?.length === 0 && !failure && (
            <div className="chat-model-empty">This session offers no other model</div>
          )}
          {options?.map((option) => {
            const selected = option === current
            return (
              <DropdownMenu.Item
                key={option.id}
                className="menu-item chat-model-option"
                data-selected={selected ? 'true' : undefined}
                onSelect={() => onSelect(option.id)}
              >
                <span className="chat-model-option-text">
                  <span className="truncate">{option.label}</span>
                  {option.hint && <span className="chat-model-option-hint">{option.hint}</span>}
                </span>
                {selected && <CheckIcon className="select-option-check" />}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
