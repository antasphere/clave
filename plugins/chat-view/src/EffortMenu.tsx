import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import type { ModelOption } from '../../../src/shared/session-model'
import { effortChoice } from './models'

/** The reasoning-effort chip beside the model chip, and the menu it opens.
 *  Shown only while the session's model takes an effort: it asks the
 *  provider for its models when the pane opens and again at every model
 *  switch, since each model says which levels it takes (Haiku none, a Codex
 *  model up to Ultra). The chip names the level the provider reported,
 *  never the one last clicked. */
export function EffortMenu({
  sessionId,
  model,
  effort,
  disabled,
  onSelect
}: {
  sessionId: string
  model: string | null
  effort: string | null
  disabled: boolean
  onSelect: (id: string) => void
}): React.JSX.Element | null {
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  useEffect(() => {
    let live = true
    // A host older than this plugin has no sessionsModels, and a provider may
    // fail to list: either way there is no chip, never a crashed pane.
    Promise.resolve()
      .then(() => window.electronAPI.sessionsModels(sessionId))
      .then((list) => {
        if (live) setOptions(list)
      })
      .catch(() => {
        if (live) setOptions([])
      })
    return () => {
      live = false
    }
  }, [sessionId, model])
  const choice = effortChoice(model, effort, options)
  if (!choice) return null
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger"
          aria-label="Reasoning effort"
          title="Change reasoning effort"
          disabled={disabled}
        >
          <span className="chat-model-trigger-label">{choice.current?.label ?? 'Effort'}</span>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Reasoning efforts"
        >
          <DropdownMenu.Label className="menu-label">Reasoning effort</DropdownMenu.Label>
          {choice.efforts.map((option) => {
            const selected = option === choice.current
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
