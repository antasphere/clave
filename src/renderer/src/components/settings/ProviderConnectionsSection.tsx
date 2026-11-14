import { useEffect, useRef, useState, type ReactElement } from 'react'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  ensureUsageLine,
  usageLineTextFor,
  useUsageLineStore
} from '../../store/models-catalog-store'
import {
  ArrowTopRightOnSquareIcon,
  ClipboardDocumentIcon,
  PencilSquareIcon,
  TrashIcon
} from '@heroicons/react/24/outline'
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
import { ownUsageText, providerCardFacts, type CardCompany } from './connection-cards'
import { useConnectionUsage, useHarnessUsage } from '../../store/harness-usage-store'
import {
  CardFact,
  CardFacts,
  CardFold,
  CardFoot,
  CardHead,
  CardLabel,
  CardStateText,
  CompanyWhat,
  ConnectionCard,
  HarnessList,
  ModelList,
  RemoveConfirm,
  UsageLine,
  type CardModels
} from './ConnectionCard'
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

/** One stored connection as a card: its label, its key in plain words, the
 *  harnesses its endpoints serve, its company's models, its usage line. */
function ProviderConnectionCard({
  machine,
  machineWords,
  connection,
  usage,
  models,
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
  models: CardModels
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
    <ConnectionCard
      tone={facts.state.tone}
      wide={keyFormOpen}
      data-provider-connection-row={connection.id}
    >
      <CardHead
        company={facts.company}
        title={
          <CardLabel
            label={connection.label}
            draft={draft}
            onDraft={setDraft}
            onCommit={(label) => void rename(machine, connection.id, label)}
            labelProps={{ 'data-provider-connection-label': connection.id }}
            inputProps={{ 'data-provider-rename-input': true }}
          />
        }
        subtitle={<CompanyWhat company={facts.companyName} what={facts.what} />}
        aside={
          <CardStateText state={facts.state} data-provider-connection-key-state={connection.id} />
        }
      />
      <CardFacts>
        <CardFact term="Harnesses">
          <HarnessList harnesses={facts.harnesses} />
        </CardFact>
        <CardFact term="Models">
          <ModelList models={models} id={connection.id} />
        </CardFact>
        {ownAddress && host && (
          <CardFact term="Address">
            <span className="connection-card-quiet">{host}</span>
          </CardFact>
        )}
        <CardFact term="Usage">
          <UsageLine
            text={connection.hasKey || !connection.needsKey ? usage : 'Read once the key is stored'}
            id={connection.id}
            own={own}
            data-provider-connection-usage={usage ? connection.id : undefined}
          />
        </CardFact>
      </CardFacts>
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
      <CardFoot hidden={confirming || keyFormOpen}>
        {connection.needsKey && !connection.hasKey && (
          <button
            type="button"
            className="btn-secondary btn-compact"
            onClick={onKey}
            data-connection-fix={connection.id}
          >
            Paste the key
          </button>
        )}
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
          onClick={() => setConfirming(true)}
          title="Remove"
          aria-label={`Remove connection ${connection.label}`}
          data-provider-remove={connection.id}
        >
          <TrashIcon className="w-3.5 h-3.5" />
        </button>
      </CardFoot>
    </ConnectionCard>
  )
}

/**
 * The provider connections of one machine as cards, grouped by company in
 * catalogue order (each group a `data-provider-company-section` that takes no
 * room of its own in the grid). `modelsOf` names what a company's catalogue
 * serves.
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
  /** An add form is open on the page: the store's sentence shows in it. */
  addOpen: boolean
}): ReactElement {
  const state = useProviderConnectionsOf(machine)
  const clearError = useProviderConnectionsStore((s) => s.clearError)
  // The open key form, for the machine it was opened on.
  const [keyForm, setKeyForm] = useState<{ machine: string; id: string } | null>(null)
  const keyFor = keyForm?.machine === machine ? keyForm.id : null
  // Lane C of the harness wave (PRDCT-4496): each connection's usage line,
  // read when the page shows it and again, forced, once its key is set.
  useUsageLines(machine, state.connections)
  const companies = PROVIDER_COMPANIES.map((company) => ({
    company,
    connections: state.connections.filter((c) => c.company === company.id)
  })).filter((entry) => entry.connections.length > 0)
  return (
    <>
      {companies.map(({ company, connections }) => (
        <div
          key={company.id}
          className="connection-grid-group"
          data-provider-company-section={company.id}
        >
          {connections.map((connection) => (
            <ProviderConnectionCard
              key={connection.id}
              machine={machine}
              machineWords={machineWords}
              connection={connection}
              usage={
                connection.hasKey || !connection.needsKey
                  ? usageLineTextFor(machine, connection.id)
                  : null
              }
              models={modelsOf(company.id)}
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
        </div>
      ))}
      {state.error && !keyFor && !addOpen && (
        <div className="connection-grid-note">
          <SettingsCallout tone="danger" role="alert" text={state.error} />
        </div>
      )}
    </>
  )
}
