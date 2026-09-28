import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'
import type { PermissionModeOption } from '../../../src/shared/session-model'

/** The permission-mode chip on the composer's footer and the menu it opens
 *  above it, beside the model's. The modes and their names are the
 *  provider's, sent on the session's `permission_mode` event; a provider that
 *  sends none gets no chip. */
export function PermissionModeMenu({
  mode,
  modes,
  disabled,
  label = (option) => option.label,
  onSelect
}: {
  mode: string
  modes: PermissionModeOption[]
  disabled: boolean
  /** How a view names a mode, when not by the provider's own label. */
  label?: (option: PermissionModeOption) => string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const current = modes.find((m) => m.id === mode)
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="chat-model-trigger"
          aria-label="Permission mode"
          title="Change permission mode (Shift+Tab)"
          data-mode={mode}
          disabled={disabled}
        >
          <span className="chat-model-trigger-label">{current ? label(current) : mode}</span>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Permission modes"
        >
          <DropdownMenu.Label className="menu-label">Permission mode</DropdownMenu.Label>
          {modes.map((option) => {
            const selected = option.id === mode
            return (
              <DropdownMenu.Item
                key={option.id}
                className="menu-item chat-model-option"
                data-selected={selected ? 'true' : undefined}
                onSelect={() => onSelect(option.id)}
              >
                <span className="chat-model-option-text">
                  <span className="truncate">{label(option)}</span>
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
