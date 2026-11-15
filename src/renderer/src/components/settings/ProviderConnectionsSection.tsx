import { useEffect, useRef, useState, type ReactElement } from 'react'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  ensureUsageLine,
  usageLineTextFor,
  useUsageLineStore
} from '../../store/models-catalog-store'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import type { ProviderConnection, ProviderWireFormat } from '../../../../preload/index.d'
import { useProviderConnectionsStore } from '../../store/provider-connections-store'
import { useProviderConnectionsOf } from './connection-actions'
import {
  PROVIDER_COMPANIES,
  PROVIDER_WIRE_FORMAT_NAMES,
  providerCompany,
  type ProviderCompany
} from '@clave/contract/settings/provider-catalogue'
import { nextProviderLabel } from './connection-companies'
import {
  connectLabel,
  ownUsageText,
  providerCardFacts,
  rowMenuEntries,
  type CardCompany
} from './connection-cards'
import { useConnectionUsage, useHarnessUsage } from '../../store/harness-usage-store'
import {
  CardFold,
  CardLabel,
  ConnectionRow,
  ProviderCard,
  RemoveConfirm,
  RowMenu,
  RowNote,
  UsageLine,
  type CardModels
} from './ConnectionCard'
import { reveal } from './connection-actions'
import { SettingsCallout, SettingsSelect } from './primitives'

/**
 * The provider connections of one machine on Settings → Connections
 * (PRDCT-4426, as cards since PRDCT-4552): a key stored once for a company's
 * coding plan or API, a local Ollama, or another provider's endpoint. One
 * card per connection, in catalogue order; the key form a card opens in its
 * place; the add form, opened from the provider's own card
 * (`ConnectionOffers`). `machine` is `LOCAL_SERVER_ID` for this Mac or a
 * saved server's id: every read and write goes to that machine, and the key a
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

/** The key form in a card: paste, save, and the input is gone with the form. */
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

/** The id of one field of the add form, per machine and per provider
 *  (PRDCT-4552): `provider-add-label-local-moonshot`. A machine or company
 *  id is kept to the characters an id selector reads plainly. */
function addFormFieldId(machine: string, company: string): (field: string) => string {
  const safe = (part: string): string => part.replace(/[^A-Za-z0-9_-]/g, '_')
  return (field) => `provider-add-${field}-${safe(machine)}-${safe(company)}`
}

/** The add form: one form for a catalogue company, Ollama and another
 *  provider, opened in the provider's card. */
export function AddForm({
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
  // One id per field, provider and machine: two cards' forms open at once
  // (a company's "Connect another" and "Another provider") never share one.
  const fieldId = addFormFieldId(machine, company.id)
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
      // card says the key is missing and the sentence shows on the page.
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
            <label className="field-label" htmlFor={fieldId('label')}>
              Label
            </label>
            <input
              id={fieldId('label')}
              className="input-compact w-full max-w-72"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
              data-provider-add-label
            />
          </div>
          {company.takesBaseUrl && (
            <div>
              <label className="field-label" htmlFor={fieldId('base-url')}>
                Base URL
              </label>
              <input
                id={fieldId('base-url')}
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
              <label className="field-label" htmlFor={fieldId('key')}>
                Key
              </label>
              <input
                id={fieldId('key')}
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

/** One stored connection as a row of its provider's card: its label, its key
 *  in a word, its usage (the provider's line and its own tabs', named
 *  apart), the address it was given (Ollama, another provider). */
function ProviderConnectionRow({
  machine,
  machineWords,
  connection,
  usage,
  keyFormOpen,
  error,
  onKey,
  onKeyClose
}: {
  machine: string
  machineWords: string
  connection: ProviderConnection
  /** Its usage line (PRDCT-4496), or null while it is not read. */
  usage: string | null
  keyFormOpen: boolean
  error: string | null
  onKey: () => void
  onKeyClose: () => void
}): ReactElement {
  const rename = useProviderConnectionsStore((s) => s.rename)
  const remove = useProviderConnectionsStore((s) => s.remove)
  const [draft, setDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const facts = providerCardFacts(connection)
  const ownAddress = connection.company === 'ollama' || connection.company === 'generic'
  const host = connection.endpoints[0] ? hostOf(connection.endpoints[0].baseUrl) : null
  // PRDCT-4551: what this connection's own Pi and OpenCode tabs used today,
  // read on the machine whose page this is.
  const used = useConnectionUsage(machine, connection.id)
  const read = useHarnessUsage(machine, 'today')
  const own = ownUsageText(read?.status, used)
  return (
    <ConnectionRow
      data-provider-connection-row={connection.id}
      heading={
        <CardLabel
          label={connection.label}
          draft={draft}
          onDraft={setDraft}
          onCommit={(label) => void rename(machine, connection.id, label)}
          labelProps={{ 'data-provider-connection-label': connection.id }}
          inputProps={{ 'data-provider-rename-input': true }}
        />
      }
      state={facts.state}
      stateAttrs={{ 'data-provider-connection-key-state': connection.id }}
      fix={
        connection.needsKey &&
        !connection.hasKey && (
          <button
            type="button"
            className="btn-secondary btn-compact"
            onClick={onKey}
            data-connection-fix={connection.id}
          >
            Paste the key
          </button>
        )
      }
      menu={
        <RowMenu
          id={connection.id}
          label={connection.label}
          entries={rowMenuEntries({
            kind: connection.needsKey ? 'provider-key' : 'provider-local',
            signedIn: connection.hasKey,
            onRename: () => setDraft(connection.label),
            onCredential: connection.needsKey ? onKey : undefined,
            onRemove: () => setConfirming(true),
            hooks: {
              rename: { 'data-provider-rename': connection.id },
              credential: { 'data-provider-key': connection.id },
              remove: { 'data-provider-remove': connection.id }
            }
          })}
        />
      }
      lines={
        <>
          <UsageLine
            text={connection.hasKey || !connection.needsKey ? usage : 'Read once the key is stored'}
            id={connection.id}
            own={own}
            data-provider-connection-usage={usage ? connection.id : undefined}
          />
          {ownAddress && host && <RowNote>{host}</RowNote>}
        </>
      }
      fold={
        <>
          <CardFold open={keyFormOpen}>
            <KeyForm machine={machine} connection={connection} error={error} onClose={onKeyClose} />
          </CardFold>
          <CardFold open={confirming}>
            <RemoveConfirm
              kind={connection.needsKey ? 'provider-key' : 'provider-local'}
              label={connection.label}
              machine={machineWords}
              id={connection.id}
              onCancel={() => setConfirming(false)}
              onRemove={() => {
                setConfirming(false)
                void remove(machine, connection.id)
              }}
            />
          </CardFold>
        </>
      }
    />
  )
}

/**
 * The stored connections of one machine (PRDCT-4552): one card per provider
 * that has any, in catalogue order, its connections as rows, its foot
 * connecting another (the add form opening inside the card). `modelsOf`
 * names what a company's catalogue serves.
 */
export function ProviderConnectionCards({
  machine,
  machineWords,
  modelsOf,
  addOpen
}: {
  machine: string
  machineWords: string
  modelsOf: (company: CardCompany) => CardModels
  /** A form to connect a provider is open below: the store's sentence shows in it. */
  addOpen: boolean
}): ReactElement {
  const state = useProviderConnectionsOf(machine)
  const clearError = useProviderConnectionsStore((s) => s.clearError)
  // The open key form and the open add form, for the machine they were
  // opened on (switching the machine closes them, derived during render).
  const [keyForm, setKeyForm] = useState<{ machine: string; id: string } | null>(null)
  const keyFor = keyForm?.machine === machine ? keyForm.id : null
  const [addForm, setAddForm] = useState<{ machine: string; company: string } | null>(null)
  const addFor = addForm?.machine === machine ? addForm.company : null
  // Lane C of the harness wave (PRDCT-4496): each connection's usage line,
  // read when the page shows it and again, forced, once its key is set.
  useUsageLines(machine, state.connections)
  const companies = PROVIDER_COMPANIES.map((company) => ({
    company,
    connections: state.connections.filter((c) => c.company === company.id)
  })).filter((entry) => entry.connections.length > 0)
  return (
    <>
      {companies.map(({ company, connections }) => {
        const facts = providerCardFacts({
          company: company.id,
          needsKey: company.needsKey,
          hasKey: false,
          endpoints: connections[0].endpoints
        })
        return (
          <ProviderCard
            key={company.id}
            company={company.id}
            name={company.name}
            what={facts.what}
            harnesses={facts.harnesses}
            models={modelsOf(company.id)}
            modelsId={company.id}
            data-provider-card={company.id}
            data-provider-company-section={company.id}
            rows={connections.map((connection) => (
              <ProviderConnectionRow
                key={connection.id}
                machine={machine}
                machineWords={machineWords}
                connection={connection}
                usage={
                  connection.hasKey || !connection.needsKey
                    ? usageLineTextFor(machine, connection.id)
                    : null
                }
                keyFormOpen={keyFor === connection.id}
                error={state.error}
                onKey={() => {
                  clearError(machine)
                  setKeyForm({ machine, id: connection.id })
                }}
                onKeyClose={() => {
                  clearError(machine)
                  setKeyForm(null)
                }}
              />
            ))}
            form={
              addFor === company.id ? (
                <AddForm
                  key={`${machine}:${company.id}`}
                  machine={machine}
                  company={company}
                  taken={connections.map((c) => c.label)}
                  error={state.error}
                  onCancel={() => {
                    clearError(machine)
                    setAddForm(null)
                  }}
                  onDone={() => setAddForm(null)}
                />
              ) : null
            }
            foot={
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={() => {
                  clearError(machine)
                  setAddForm({ machine, company: company.id })
                  reveal(`[data-provider-card="${company.id}"]`)
                }}
                data-connect-company={company.id}
              >
                {connectLabel(connections.length)}
              </button>
            }
          />
        )
      })}
      {state.error && !keyFor && !addFor && !addOpen && (
        <SettingsCallout tone="danger" role="alert" text={state.error} />
      )}
    </>
  )
}
