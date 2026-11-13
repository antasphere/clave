import { useEffect, useState } from 'react'
import * as DropdownMenu from '@clave/ui/primitives/dropdown-menu'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline'
import type { ModelOption } from '../../../src/shared/session-model'
import type { ProviderChoice } from '../../../src/preload/index.d'
import {
  currentOption,
  foldModelOptions,
  modelChipLabel,
  providerChipLabel,
  providerLabel
} from './models'

/** A model of another provider, picked from the menu: the tab is to move
 *  there (PRDCT-4300, `ProviderSwitch`). */
export interface ProviderPick {
  adapterId: string
  provider: string
  label: string
  model: ModelOption
}

/** One model row, the same in every submenu. */
function ModelRow({
  option,
  selected,
  onSelect
}: {
  option: ModelOption
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu.Item
      className="menu-item chat-model-option"
      data-selected={selected ? 'true' : undefined}
      onSelect={onSelect}
    >
      <span className="chat-model-option-text">
        <span className="truncate">{option.label}</span>
        {option.hint && <span className="chat-model-option-hint">{option.hint}</span>}
      </span>
      {selected && <CheckIcon className="select-option-check" />}
    </DropdownMenu.Item>
  )
}

/** The models of a provider the tab is not on, asked of the host with no
 *  session (`adaptersModels`, cached for the boot) when the submenu opens. */
function ProviderModels({
  choice,
  cwd,
  onPick
}: {
  choice: ProviderChoice
  cwd: string
  onPick: (pick: ProviderPick) => void
}): React.JSX.Element {
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.electronAPI.adaptersModels(choice.adapterId, cwd))
      .then((list) => {
        if (live) setOptions(list)
      })
      .catch((error) => {
        if (live) setFailure(String(error))
      })
    return () => {
      live = false
    }
  }, [choice.adapterId, cwd])
  const { current, earlier } = foldModelOptions(options ?? [])
  const row = (option: ModelOption): React.JSX.Element => (
    <ModelRow
      key={option.id}
      option={option}
      selected={false}
      onSelect={() => onPick({ ...choice, model: option })}
    />
  )
  return (
    <>
      {options === null && !failure && <div className="chat-model-empty">Loading…</div>}
      {failure && <div className="chat-model-empty">Models unavailable</div>}
      {options?.length === 0 && !failure && (
        <div className="chat-model-empty">{choice.label} offers no model here</div>
      )}
      {current.map(row)}
      {earlier.length > 0 && <EarlierVersions rows={earlier.map(row)} current={undefined} />}
    </>
  )
}

/** The older versions of a family, one layer down (PRDCT-4257): a session
 *  on one shows it selected here, and the row says so. */
function EarlierVersions({
  rows,
  current
}: {
  rows: React.JSX.Element[]
  current: ModelOption | undefined
}): React.JSX.Element {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger
        className="menu-item chat-model-option chat-model-earlier"
        data-selected={current ? 'true' : undefined}
      >
        <span className="chat-model-option-text">
          <span className="truncate">Earlier versions</span>
          {current && <span className="chat-model-option-hint">{current.label}</span>}
        </span>
        <ChevronRightIcon className="chat-model-earlier-chevron" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          sideOffset={6}
          alignOffset={-6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Earlier versions"
        >
          {rows}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

/** The model chip on the composer's footer and the menu it opens above it:
 *  the provider first, then that provider's models (PRDCT-4300). The chip
 *  reads "Claude · Fable 5.1". The tab's own provider lists the models its
 *  session offers (`sessionsModels`, folded by family); every other provider
 *  this host can run lists its own, and a pick there is a move of the tab
 *  (`onSwitchProvider`), never a silent restart. */
export function ModelMenu({
  sessionId,
  model,
  pending = false,
  disabled,
  onSelect,
  provider,
  adapterId,
  cwd,
  onSwitchProvider
}: {
  sessionId: string
  /** The model the chip names: the reader's pick while the provider has not
   *  answered it, else the model the provider reported (PRDCT-4273). */
  model: string | null
  /** The pick is awaiting the provider's answer: marked on the chip for a
   *  reader of the DOM; nothing is disabled, since a message written after
   *  the switch runs on the new model. */
  pending?: boolean
  disabled: boolean
  onSelect: (id: string) => void
  /** The provider the tab is on, as the host names it (`claude`, `codex`). */
  provider: string
  /** The adapter the tab runs on (`claude-chat`); the current provider's row. */
  adapterId: string
  cwd: string
  onSwitchProvider?: (pick: ProviderPick) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [providers, setProviders] = useState<ProviderChoice[] | null>(null)
  // The list is asked once at mount, so the chip names the model from its
  // first look (a Codex id reads as its label, not as "gpt-5.5"), and again
  // at every opening, from a clean slate (integration round 2, N5).
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.electronAPI.sessionsModels(sessionId))
      .then((list) => {
        if (live) setOptions((current) => current ?? list)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [sessionId])
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
    // The other providers, the same way: a host without the call lists the
    // tab's own provider alone.
    Promise.resolve()
      .then(() => window.electronAPI.adaptersList())
      .then((list) => {
        if (live) setProviders(list)
      })
      .catch(() => {
        if (live) setProviders([])
      })
    return () => {
      live = false
    }
  }, [open, sessionId])
  const current = currentOption(model, options)
  const { current: listed, earlier } = foldModelOptions(options ?? [])
  const row = (option: ModelOption): React.JSX.Element => (
    <ModelRow
      key={option.id}
      option={option}
      selected={option === current}
      onSelect={() => onSelect(option.id)}
    />
  )
  const own: ProviderChoice = { adapterId, provider, label: providerLabel(provider) }
  // Another provider is listed only where a pick can move the tab: a remote
  // tab and the Folio's read-only chip offer the tab's own models alone
  // (integration round 2, F13).
  const others = onSwitchProvider ? (providers ?? []).filter((p) => p.adapterId !== adapterId) : []
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
          title="Change provider or model"
          disabled={disabled}
          data-pending={pending ? 'true' : undefined}
        >
          <span className="chat-model-trigger-label">
            {providerChipLabel(provider, model, options)}
          </span>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop chat-model-menu z-50"
          aria-label="Providers"
        >
          <DropdownMenu.Label className="menu-label">
            Select provider, then model
          </DropdownMenu.Label>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger
              className="menu-item chat-model-option chat-model-provider"
              data-adapter={own.adapterId}
              data-selected="true"
            >
              <span className="chat-model-option-text">
                <span className="truncate">{own.label}</span>
                <span className="chat-model-option-hint">{modelChipLabel(model, options)}</span>
              </span>
              <ChevronRightIcon className="chat-model-earlier-chevron" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent
                sideOffset={6}
                alignOffset={-6}
                className="menu-surface menu-pop chat-model-menu z-50"
                aria-label="Models"
              >
                <DropdownMenu.Label className="menu-label">Select model</DropdownMenu.Label>
                {options === null && !failure && <div className="chat-model-empty">Loading…</div>}
                {failure && <div className="chat-model-empty">Models unavailable</div>}
                {options?.length === 0 && !failure && (
                  <div className="chat-model-empty">This session offers no other model</div>
                )}
                {listed.map(row)}
                {earlier.length > 0 && (
                  <EarlierVersions
                    rows={earlier.map(row)}
                    current={current && earlier.includes(current) ? current : undefined}
                  />
                )}
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          {others.map((choice) => (
            <DropdownMenu.Sub key={choice.adapterId}>
              <DropdownMenu.SubTrigger
                className="menu-item chat-model-option chat-model-provider"
                data-adapter={choice.adapterId}
              >
                <span className="chat-model-option-text">
                  <span className="truncate">{choice.label}</span>
                  <span className="chat-model-option-hint">Move this conversation</span>
                </span>
                <ChevronRightIcon className="chat-model-earlier-chevron" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  sideOffset={6}
                  alignOffset={-6}
                  className="menu-surface menu-pop chat-model-menu z-50"
                  aria-label={`${choice.label} models`}
                >
                  <DropdownMenu.Label className="menu-label">
                    Move to {choice.label} on
                  </DropdownMenu.Label>
                  <ProviderModels
                    choice={choice}
                    cwd={cwd}
                    onPick={(pick) => onSwitchProvider?.(pick)}
                  />
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
