import { useEffect, useRef, useState, type ReactElement } from 'react'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  ensureUsageLine,
  usageLineTextFor,
  useUsageLineStore
} from '../../store/models-catalog-store'
import * as DropdownMenuPrimitive from '@clave/ui/primitives/dropdown-menu'
import {
  ArrowTopRightOnSquareIcon,
  ClipboardDocumentIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon
} from '@heroicons/react/24/outline'
import type {
  ProviderCompanyId,
  ProviderConnection,
  ProviderWireFormat
} from '../../../../preload/index.d'
import {
  startProviderConnectionsEvents,
  useProviderConnectionsStore,
  EMPTY_MACHINE_PROVIDER_CONNECTIONS,
  type MachineProviderConnections
} from '../../store/provider-connections-store'
import {
  PROVIDER_COMPANIES,
  PROVIDER_WIRE_FORMAT_NAMES,
  providerCompany,
  type ProviderCompany
} from '@clave/contract/settings/provider-catalogue'
import { PROVIDER_CONNECT_ITEMS, nextProviderLabel } from './connection-companies'
import { SettingsCallout, SettingsCard, SettingsSection, SettingsSelect } from './primitives'

/**
 * The provider connections of one machine on Settings → Connections
 * (PRDCT-4426): a key stored once for a company's coding plan or API, a local
 * Ollama, or another provider's endpoint. One section per company that has a
 * connection, in catalogue order; the add form a Connect pick opens; the key
 * form a row opens. `machine` is `LOCAL_SERVER_ID` for this Mac or a saved
 * server's id: every read and write goes to that machine, and the key a
 * person pastes passes through one call and is kept in no state here once the
 * form closes.
 */

const WIRE_FORMAT_OPTIONS = (Object.keys(PROVIDER_WIRE_FORMAT_NAMES) as ProviderWireFormat[]).map(
  (value) => ({ value, label: PROVIDER_WIRE_FORMAT_NAMES[value] })
)

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

function keyStateOf(connection: ProviderConnection): string {
  if (!connection.needsKey) return 'No key needed'
  return connection.hasKey ? 'Key stored' : 'No key yet'
}

/** Reads the usage line of every connection that can be read (its key
 *  stored, or none needed) on `machine`, and subscribes the caller to the
 *  lines. A key set or replaced since the last read is read again at once. */
function useUsageLines(machine: string, connections: readonly ProviderConnection[]): void {
  useUsageLineStore((s) => s.byConnection)
  const readable = connections
    .filter((c) => c.hasKey || !c.needsKey)
    .map((c) => `${c.id}\u0001${c.keySetAt ?? ''}`)
    .join('\u0000')
  const seen = useRef(new Map<string, string>())
  useEffect(() => {
    if (!readable) return
    const api = window.electronAPI
    for (const entry of readable.split('\u0000')) {
      const [connectionId, setAt] = entry.split('\u0001')
      const seenKey = `${machine}\u0000${connectionId}`
      const before = seen.current.get(seenKey)
      seen.current.set(seenKey, setAt)
      const force = before !== undefined && before !== setAt
      void ensureUsageLine(
        machine,
        connectionId,
        () =>
          machine === LOCAL_SERVER_ID
            ? api.providerUsageRead({ connectionId, force })
            : api.fleetProviderUsage(machine, { connectionId, force }),
        { force }
      )
    }
  }, [machine, readable])
}

function useMachine(machine: string): MachineProviderConnections {
  return useProviderConnectionsStore(
    (s) => s.byMachine[machine] ?? EMPTY_MACHINE_PROVIDER_CONNECTIONS
  )
}

/** The note line under a form: the store's sentence for that machine. */
function FormNote({
  text,
  attribute
}: {
  text: string | null
  attribute: string
}): ReactElement | null {
  if (!text) return null
  return (
    <p className="text-xs text-destructive" {...{ [attribute]: 'error' }}>
      {text}
    </p>
  )
}

/** The key form under a row: paste, save, and the input is gone with the form. */
function KeyForm({
  machine,
  connection,
  error,
  onClose
}: {
  machine: string
  connection: ProviderConnection
  error: string | null
  onClose: () => void
}): ReactElement {
  const setKey = useProviderConnectionsStore((s) => s.setKey)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const name = providerCompany(connection.company).name
  const submit = async (): Promise<void> => {
    if (busy || !value) return
    setBusy(true)
    const ok = await setKey(machine, connection.id, value)
    setBusy(false)
    if (ok) {
      setValue('')
      onClose()
    }
  }
  return (
    <div data-provider-key-form={connection.id}>
      <SettingsCallout
        inset
        tone="accent"
        text={`Paste the ${name} key. It is stored sealed and never shown again.`}
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setValue('')
                onClose()
              }}
              data-provider-key-cancel
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !value}
              onClick={() => void submit()}
              data-provider-key-save
            >
              Save the key
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2 mt-2">
          <input
            className="input-compact w-full max-w-md"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`${name} key`}
            autoFocus
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            data-provider-key-input
          />
          <FormNote text={error} attribute="data-provider-key-note" />
        </div>
      </SettingsCallout>
    </div>
  )
}

/** One connection: its label, its endpoint's host, whether its key is stored. */
function ConnectionRow({
  machine,
  connection,
  usage,
  onKey
}: {
  machine: string
  connection: ProviderConnection
  /** Its usage line (PRDCT-4496), or null while it is not read. */
  usage: string | null
  onKey: () => void
}): ReactElement {
  const rename = useProviderConnectionsStore((s) => s.rename)
  const remove = useProviderConnectionsStore((s) => s.remove)
  const [draft, setDraft] = useState<string | null>(null)
  const host = connection.endpoints[0] ? hostOf(connection.endpoints[0].baseUrl) : null
  const commit = (): void => {
    if (draft === null) return
    const label = draft.trim()
    setDraft(null)
    if (label && label !== connection.label) void rename(machine, connection.id, label)
  }
  return (
    <div className="settings-row" data-provider-connection-row={connection.id}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          {draft === null ? (
            <p
              className="settings-row-title truncate"
              data-provider-connection-label={connection.id}
            >
              {connection.label}
            </p>
          ) : (
            <input
              className="input-compact w-full max-w-56"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setDraft(null)
              }}
              aria-label="Connection name"
              autoFocus
              data-provider-rename-input
            />
          )}
          <span
            className="badge badge-muted flex-shrink-0"
            data-provider-connection-key-state={connection.id}
          >
            {keyStateOf(connection)}
          </span>
        </div>
        {usage && (
          <p className="settings-row-description" data-provider-connection-usage={connection.id}>
            {usage}
          </p>
        )}
        {host && (
          <div className="settings-row-tags">
            <span className="badge badge-muted">{host}</span>
          </div>
        )}
      </div>
      <div className="settings-row-controls">
        <button
          type="button"
          className="btn-icon btn-icon-sm"
          onClick={() => setDraft(connection.label)}
          title="Rename"
          aria-label={`Rename ${connection.label}`}
          data-provider-rename={connection.id}
        >
          <PencilSquareIcon className="w-3.5 h-3.5" />
        </button>
        {connection.needsKey && (
          <button
            type="button"
            className="btn-icon btn-icon-sm"
            onClick={onKey}
            title={connection.hasKey ? 'Replace the key' : 'Paste a key'}
            aria-label={
              connection.hasKey
                ? `Replace the key of ${connection.label}`
                : `Paste a key for ${connection.label}`
            }
            data-provider-key={connection.id}
          >
            <ClipboardDocumentIcon className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          className="btn-icon btn-icon-sm btn-icon--danger"
          onClick={() => void remove(machine, connection.id)}
          title="Remove"
          aria-label={`Remove connection ${connection.label}`}
          data-provider-remove={connection.id}
        >
          <TrashIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

/** The add form: one form for a catalogue company, Ollama and another provider. */
function AddForm({
  machine,
  company,
  taken,
  error,
  onCancel,
  onDone
}: {
  machine: string
  company: ProviderCompany
  taken: string[]
  error: string | null
  onCancel: () => void
  onDone: () => void
}): ReactElement {
  const add = useProviderConnectionsStore((s) => s.add)
  const [label, setLabel] = useState(() => nextProviderLabel(company.name, taken))
  const [baseUrl, setBaseUrl] = useState(() =>
    company.id === 'generic' ? '' : (company.endpoints[0]?.baseUrl ?? '')
  )
  const [wireFormat, setWireFormat] = useState<ProviderWireFormat>('openai-chat')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const missing =
    !label.trim() || (company.takesBaseUrl && !baseUrl.trim()) || (company.needsKey && !apiKey)
  const keyHost = company.keyUrl ? hostOf(company.keyUrl) : null
  const submit = async (): Promise<void> => {
    if (busy || missing) return
    setBusy(true)
    const created = await add(machine, {
      company: company.id,
      label: label.trim(),
      ...(company.takesBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
      ...(company.takesWireFormat ? { wireFormat } : {}),
      ...(company.needsKey ? { apiKey } : {})
    })
    setBusy(false)
    if (created) {
      setApiKey('')
      // A key refused after the connection was made: the form closes, the
      // row says the key is missing and the sentence shows under the sections.
      onDone()
    }
  }
  return (
    <div data-provider-add-form={company.id}>
      <SettingsCallout
        inset
        tone="accent"
        title={company.id === 'generic' ? 'Connect another provider' : `Connect ${company.name}`}
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setApiKey('')
                onCancel()
              }}
              data-provider-add-cancel
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || missing}
              onClick={() => void submit()}
              data-provider-add-save
            >
              Connect
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3 mt-2">
          <div>
            <label className="field-label" htmlFor={`provider-add-label-${machine}`}>
              Label
            </label>
            <input
              id={`provider-add-label-${machine}`}
              className="input-compact w-full max-w-72"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
              data-provider-add-label
            />
          </div>
          {company.takesBaseUrl && (
            <div>
              <label className="field-label" htmlFor={`provider-add-base-url-${machine}`}>
                Base URL
              </label>
              <input
                id={`provider-add-base-url-${machine}`}
                className="input-compact w-full max-w-md"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://"
                data-provider-add-base-url
              />
            </div>
          )}
          {company.takesWireFormat && (
            <div data-provider-add-wire-format={wireFormat}>
              <span className="field-label">Wire format</span>
              <SettingsSelect<ProviderWireFormat>
                value={wireFormat}
                options={WIRE_FORMAT_OPTIONS}
                onChange={setWireFormat}
                ariaLabel="Wire format"
                testId="provider-add-wire-format"
              />
            </div>
          )}
          {company.needsKey && (
            <div>
              <label className="field-label" htmlFor={`provider-add-key-${machine}`}>
                Key
              </label>
              <input
                id={`provider-add-key-${machine}`}
                className="input-compact w-full max-w-md"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
                data-provider-add-key
              />
            </div>
          )}
          {company.keyUrl && keyHost && (
            <p className="text-xs text-text-secondary">
              Keys:{' '}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => void window.electronAPI.openExternal(company.keyUrl!)}
                data-provider-add-key-link
              >
                {keyHost}
                <ArrowTopRightOnSquareIcon className="w-3 h-3 inline-block ml-0.5 align-[-1px]" />
              </button>
            </p>
          )}
          <FormNote text={error} attribute="data-provider-add-note" />
        </div>
      </SettingsCallout>
    </div>
  )
}

/**
 * The provider connections of one machine, a section per company that has
 * one, then the add form while `addRequest` names a company.
 */
export function ProviderConnectionsSections({
  machine,
  addRequest,
  onAddDone
}: {
  machine: string
  addRequest: ProviderCompanyId | null
  onAddDone: () => void
}): ReactElement | null {
  const state = useMachine(machine)
  const load = useProviderConnectionsStore((s) => s.load)
  const clearError = useProviderConnectionsStore((s) => s.clearError)
  // The open key form, for the machine it was opened on.
  const [keyForm, setKeyForm] = useState<{ machine: string; id: string } | null>(null)
  const keyFor = keyForm?.machine === machine ? keyForm.id : null
  const setKeyFor = (id: string | null): void => setKeyForm(id ? { machine, id } : null)
  useEffect(() => {
    startProviderConnectionsEvents()
  }, [])
  useEffect(() => {
    void load(machine)
  }, [machine, load])
  // Lane C of the harness wave (PRDCT-4496): each connection's usage line,
  // read when the section shows it and again, forced, once its key is set.
  useUsageLines(machine, state.connections)
  // A new pick closes the key form (derived during render, the
  // React-sanctioned shape) and clears the last sentence, which belonged to
  // another form.
  const [seenRequest, setSeenRequest] = useState(addRequest)
  if (seenRequest !== addRequest) {
    setSeenRequest(addRequest)
    if (addRequest) setKeyFor(null)
  }
  useEffect(() => {
    if (addRequest) clearError(machine)
  }, [addRequest, machine, clearError])

  const companies = PROVIDER_COMPANIES.map((company) => ({
    company,
    connections: state.connections.filter((c) => c.company === company.id)
  })).filter((entry) => entry.connections.length > 0)
  const adding = addRequest ? providerCompany(addRequest) : null
  const formOpen = adding !== null || keyFor !== null

  if (companies.length === 0 && !adding && !state.error) return null
  return (
    <>
      {companies.map(({ company, connections }) => (
        <div key={company.id} data-provider-company-section={company.id}>
          <SettingsSection
            title={
              <span className="flex items-center gap-2">
                {company.name}
                {company.plan && <span className="badge badge-muted">{company.plan}</span>}
              </span>
            }
          >
            <SettingsCard>
              {connections.map((connection) => (
                <div key={connection.id}>
                  <ConnectionRow
                    machine={machine}
                    connection={connection}
                    usage={
                      connection.hasKey || !connection.needsKey
                        ? usageLineTextFor(machine, connection.id)
                        : null
                    }
                    onKey={() => {
                      clearError(machine)
                      setKeyFor(connection.id)
                    }}
                  />
                  {keyFor === connection.id && (
                    <KeyForm
                      machine={machine}
                      connection={connection}
                      error={state.error}
                      onClose={() => {
                        clearError(machine)
                        setKeyFor(null)
                      }}
                    />
                  )}
                </div>
              ))}
            </SettingsCard>
          </SettingsSection>
        </div>
      ))}
      {adding && (
        <SettingsCard>
          <AddForm
            key={`${machine}:${adding.id}`}
            machine={machine}
            company={adding}
            taken={state.connections.filter((c) => c.company === adding.id).map((c) => c.label)}
            error={state.error}
            onCancel={() => {
              clearError(machine)
              onAddDone()
            }}
            onDone={onAddDone}
          />
        </SettingsCard>
      )}
      {state.error && !formOpen && (
        <SettingsCallout tone="danger" role="alert" text={state.error} />
      )}
    </>
  )
}

/** The provider entries of a Connect chooser: the name and the hint, no logo. */
export function ProviderConnectItems({
  onPick
}: {
  onPick: (id: ProviderCompanyId) => void
}): ReactElement {
  return (
    <>
      {PROVIDER_CONNECT_ITEMS.map((item) => (
        <DropdownMenuPrimitive.Item
          key={item.id}
          className="menu-item select-option"
          onSelect={() => onPick(item.id)}
          data-connect-company={item.id}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate">{item.name}</span>
            <span className="block truncate text-[11px] text-text-tertiary">{item.hint}</span>
          </span>
        </DropdownMenuPrimitive.Item>
      ))}
    </>
  )
}

/** A server page's Connect: the providers only, a server's subscriptions being
 *  signed in on the server itself. */
export function ProviderConnectMenu({
  onPick
}: {
  onPick: (id: ProviderCompanyId) => void
}): ReactElement {
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild>
        <button type="button" className="btn-primary" data-connect-providers>
          <PlusIcon className="w-3.5 h-3.5" />
          Connect
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="menu-surface menu-pop select-menu z-50 p-1"
          data-connect-chooser
        >
          <ProviderConnectItems onPick={onPick} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
