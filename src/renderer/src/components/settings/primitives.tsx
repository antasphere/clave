import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { CheckIcon, ChevronUpDownIcon } from '@heroicons/react/24/outline'
import { cn } from '../../lib/utils'

/**
 * The settings primitives. Every settings page is built from these and from
 * the classes they wear (`main.css`, the `── Settings ──` block): one page
 * shape, one section shape, one card, one row, one select, one switch. A page
 * never styles a control of its own; when a page needs a control these do
 * not cover, the class goes in `main.css` beside its family and the
 * component comes here.
 */

/** The page: one width for every page, a title, a one-line description, the
 *  page's own actions on the right where it has some. */
export function SettingsPage({
  title,
  description,
  actions,
  children,
  testId
}: {
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div data-settings-page={testId ?? title.toLowerCase()}>
      <header className="settings-page-header">
        <div className="min-w-0">
          <h2 className="settings-page-title">{title}</h2>
          {description && <p className="settings-page-description">{description}</p>}
        </div>
        {actions && <div className="settings-page-actions">{actions}</div>}
      </header>
      <div className="space-y-7">{children}</div>
    </div>
  )
}

/** Section title (a string or a title with a glyph) + optional description
 *  above a settings card. */
export function SettingsSection({
  title,
  description,
  children
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <div className="settings-section-head">
        <h3 className="settings-section-title">{title}</h3>
        {description && <p className="settings-section-description">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/** Grouped card: rows separated by hairline seams. */
export function SettingsCard({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cn('settings-card', className)}>{children}</div>
}

/** One row in a card: label + description left, control right. */
export function SettingsRow({
  label,
  description,
  disabled = false,
  children
}: {
  label: string
  description?: React.ReactNode
  disabled?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn('settings-row', disabled && 'opacity-50')}>
      <div className="min-w-0">
        <p className="settings-row-title">{label}</p>
        {description && <p className="settings-row-description">{description}</p>}
      </div>
      {children && <div className="flex items-center gap-1.5 flex-shrink-0">{children}</div>}
    </div>
  )
}

/** A callout under a card: a confirmation, a picker, an error. */
export function SettingsCallout({
  tone,
  title,
  text,
  children,
  className
}: {
  tone?: 'accent' | 'danger'
  title?: React.ReactNode
  text?: React.ReactNode
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('settings-callout', className)} data-tone={tone}>
      {title && <p className="settings-callout-title">{title}</p>}
      {text && <p className="settings-callout-text">{text}</p>}
      {children}
    </div>
  )
}

/** The switch used in settings rows. */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  ariaLabel
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="switch"
      data-checked={checked ? 'true' : undefined}
    >
      <span className="switch-knob" />
    </button>
  )
}

/** Toggle row shorthand: label + description left, switch right. */
export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled = false
}: {
  label: string
  description: React.ReactNode
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <SettingsRow label={label} description={description} disabled={disabled}>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} ariaLabel={label} />
    </SettingsRow>
  )
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** A second line under the label, when the option needs one (a path). */
  hint?: string
}

/**
 * The select: a trigger cut like the compact input, the options on the app's
 * own menu surface. Replaces every native `<select>` in settings, whose
 * browser-drawn chevron sat against the border and whose list was the
 * browser's, not the app's.
 */
export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Choose…',
  disabled = false,
  className,
  testId
}: {
  value: T | ''
  options: SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  className?: string
  testId?: string
}): React.JSX.Element {
  const current = options.find((o) => o.value === value)
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn('select-trigger', className)}
          aria-label={ariaLabel}
          disabled={disabled}
          data-settings-select={testId}
          data-value={value}
        >
          <span className="select-trigger-label">{current?.label ?? placeholder}</span>
          <ChevronUpDownIcon className="select-trigger-caret" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="menu-surface menu-pop select-menu z-50 p-1"
        >
          {options.map((option) => {
            const selected = option.value === value
            return (
              <DropdownMenuPrimitive.Item
                key={option.value}
                className="menu-item select-option"
                data-selected={selected ? 'true' : undefined}
                onSelect={() => onChange(option.value)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.hint && (
                    <span className="block truncate text-[11px] text-text-tertiary">
                      {option.hint}
                    </span>
                  )}
                </span>
                {selected && <CheckIcon className="select-option-check" />}
              </DropdownMenuPrimitive.Item>
            )
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
