import { useState, type ReactElement } from 'react'
import {
  TrashIcon,
  PlusIcon,
  KeyIcon,
  XMarkIcon,
  ArrowUpIcon,
  ArrowDownIcon
} from '@heroicons/react/24/outline'
import {
  useCodexAccountStore,
  DEFAULT_CODEX_ACCOUNT_ID,
  describeCodexAccountAuth
} from '../../store/codex-account-store'
import type { CodexAccount } from '../../../../preload/index.d'
import { useAccountLoginStore } from '../../store/account-login-store'
import { useCodexAccountsUsage, headroomLabel } from '../../store/usage-store'
import { isExhausted } from '../../lib/account-pool'
import { CodexLogo } from '../icons/cli-logos'
import { SettingsSection, SettingsCard, SettingsCallout, Radio } from './primitives'
import { LoginFlow } from './LoginFlow'

/** The name form for an account that signs in through the browser. */
function NameForm({
  onSubmit,
  onCancel
}: {
  onSubmit: (label: string) => Promise<void>
  onCancel: () => void
}): ReactElement {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    if (busy || !label.trim()) return
    setBusy(true)
    try {
      await onSubmit(label.trim())
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-codex-name-form>
      <SettingsCallout
        inset
        tone="accent"
        title="Add an account"
        text="Name the subscription, then sign in to ChatGPT in the browser that opens. Codex keeps the credential in a home of its own for this account; everything else — config, sessions, skills — stays shared with ~/.codex."
        actions={
          <>
            <button onClick={onCancel} className="btn-secondary">
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !label.trim()}
              className="btn-primary"
            >
              Log in
            </button>
          </>
        }
      >
        <input
          className="input-compact w-full max-w-72 mt-2"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Account name"
          aria-label="Account name"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
      </SettingsCallout>
    </div>
  )
}

/** The API-key form: a new account, or a key for an existing one. */
function ApiKeyForm({
  title,
  askName,
  onSubmit,
  onCancel
}: {
  title: string
  askName: boolean
  onSubmit: (label: string, apiKey: string) => Promise<string | null>
  onCancel: () => void
}): ReactElement {
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async (): Promise<void> => {
    if (busy || !apiKey.trim() || (askName && !label.trim())) return
    setBusy(true)
    setNote(null)
    try {
      const error = await onSubmit(label.trim(), apiKey)
      setNote(error ? { ok: false, text: error } : { ok: true, text: 'Key accepted.' })
      if (!error) setApiKey('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-codex-api-key-form>
      <SettingsCallout
        inset
        tone="accent"
        title={title}
        text="An API key bills usage instead of a subscription, so it has no limit to read: the pool only falls back to it when every subscription account is out."
        actions={
          <>
            <button onClick={onCancel} className="btn-secondary">
              {note?.ok ? 'Done' : 'Cancel'}
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !apiKey.trim() || (askName && !label.trim())}
              className="btn-primary"
            >
              {askName ? 'Add account' : 'Save key'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2 mt-2">
          {askName && (
            <input
              className="input-compact w-full max-w-72"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Account name"
              aria-label="Account name"
              autoFocus
            />
          )}
          <input
            className="input-compact w-full max-w-md"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            aria-label="OpenAI API key"
            autoFocus={!askName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
          {note && (
            <p
              className={note.ok ? 'text-xs text-text-secondary' : 'text-xs text-destructive'}
              data-codex-api-key-note={note.ok ? 'ok' : 'error'}
            >
              {note.text}
            </p>
          )}
        </div>
      </SettingsCallout>
    </div>
  )
}

function AccountRow({
  account,
  index,
  count,
  selected,
  onSelect,
  onMove,
  onLogin,
  onSetKey
}: {
  account: CodexAccount
  index: number
  count: number
  selected: boolean
  onSelect: () => void
  onMove: (offset: -1 | 1) => void
  onLogin: () => void
  onSetKey: () => void
}): ReactElement {
  const updateAccount = useCodexAccountStore((s) => s.updateAccount)
  const removeAccount = useCodexAccountStore((s) => s.removeAccount)
  const clearCredential = useCodexAccountStore((s) => s.clearCredential)
  const summary = useCodexAccountsUsage((s) => s.byAccount[account.id])
  const isDefault = account.id === DEFAULT_CODEX_ACCOUNT_ID
  const headroom = headroomLabel(summary)
  const description = [
    isDefault
      ? `${describeCodexAccountAuth(account)} · ~/.codex`
      : describeCodexAccountAuth(account),
    account.kind === 'apiKey' ? 'fallback only' : headroom,
    account.kind !== 'apiKey' && isExhausted(summary) ? 'at limit' : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="settings-row"
      data-codex-account-row={account.id}
      data-account-exhausted={
        account.kind !== 'apiKey' && isExhausted(summary) ? 'true' : undefined
      }
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Radio
          checked={selected}
          onSelect={onSelect}
          title={selected ? 'Account new sessions start on' : 'Start new sessions here'}
          ariaLabel={
            selected ? 'Account new sessions start on' : `Start new sessions on ${account.label}`
          }
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {isDefault ? (
              <p className="settings-row-title">{account.label}</p>
            ) : (
              <input
                className="input-compact w-full max-w-56"
                value={account.label}
                onChange={(e) => updateAccount(account.id, { label: e.target.value })}
                placeholder="Account name"
                aria-label="Account name"
              />
            )}
            {!account.hasCredential && (
              <span className="badge badge-muted flex-shrink-0">Needs login</span>
            )}
          </div>
          <p className="settings-row-description truncate">{description}</p>
        </div>
      </div>

      <div className="settings-row-controls">
        {!isDefault && (
          <>
            <button
              onClick={() => onMove(-1)}
              disabled={index <= 1}
              className="btn-icon btn-icon-sm"
              title="Earlier in the pool"
              aria-label={`Move ${account.label} up`}
            >
              <ArrowUpIcon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onMove(1)}
              disabled={index >= count - 1}
              className="btn-icon btn-icon-sm"
              title="Later in the pool"
              aria-label={`Move ${account.label} down`}
            >
              <ArrowDownIcon className="w-3.5 h-3.5" />
            </button>
          </>
        )}
        <button
          onClick={account.kind === 'apiKey' ? onSetKey : onLogin}
          className="btn-icon btn-icon-sm"
          title={
            account.kind === 'apiKey'
              ? account.hasCredential
                ? 'Replace the API key'
                : 'Set the API key'
              : account.hasCredential
                ? 'Log in again'
                : 'Log in'
          }
          aria-label={`Log in to ${account.label}`}
          data-codex-account-login={account.id}
        >
          <KeyIcon className="w-3.5 h-3.5" />
        </button>
        {!isDefault && account.hasCredential && (
          <button
            onClick={() => void clearCredential(account.id)}
            className="btn-icon btn-icon-sm"
            title="Forget credential"
            aria-label={`Forget credential for ${account.label}`}
          >
            <XMarkIcon className="w-3.5 h-3.5" />
          </button>
        )}
        {!isDefault && (
          <button
            onClick={() => removeAccount(account.id)}
            className="btn-icon btn-icon-sm btn-icon--danger"
            title="Remove account"
            aria-label={`Remove account ${account.label}`}
          >
            <TrashIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The Codex accounts: the machine's own `~/.codex` plus every subscription
 * handed to Clave, each a home of its own (ADR 0002). A ChatGPT account
 * signs in through the browser; an API-key account takes the key here and
 * is the pool's fallback.
 */
export function CodexAccountsSection(): ReactElement {
  const accounts = useCodexAccountStore((s) => s.accounts)
  const selectedAccountId = useCodexAccountStore((s) => s.selectedAccountId)
  const setSelectedAccount = useCodexAccountStore((s) => s.setSelectedAccount)
  const addAccount = useCodexAccountStore((s) => s.addAccount)
  const reorderAccounts = useCodexAccountStore((s) => s.reorderAccounts)
  const startLogin = useAccountLoginStore((s) => s.start)
  const startApiKey = useAccountLoginStore((s) => s.startApiKey)
  const [form, setForm] = useState<
    { kind: 'add-login' } | { kind: 'add-key' } | { kind: 'set-key'; id: string } | null
  >(null)

  const move = (index: number, offset: -1 | 1): void => {
    const ids = accounts.filter((a) => a.id !== DEFAULT_CODEX_ACCOUNT_ID).map((a) => a.id)
    const at = index - 1
    const to = at + offset
    if (to < 0 || to >= ids.length) return
    ;[ids[at], ids[to]] = [ids[to], ids[at]]
    reorderAccounts(ids)
  }

  const submitKey = async (accountId: string, apiKey: string): Promise<string | null> => {
    const job = await startApiKey(accountId, apiKey)
    return job?.status === 'done' ? null : (job?.message ?? 'Could not store the key.')
  }

  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-2">
          <CodexLogo className="w-4 h-4 text-text-tertiary" />
          Codex
        </span>
      }
      description="New Codex sessions start on the selected account and move along this list when it is about to hit its limit. Each account is a home of its own with everything but the credential linked to ~/.codex, so a thread can resume under another."
    >
      <SettingsCard>
        {accounts.map((account, index) => (
          <div key={account.id}>
            <AccountRow
              account={account}
              index={index}
              count={accounts.length}
              selected={account.id === selectedAccountId}
              onSelect={() => setSelectedAccount(account.id)}
              onMove={(offset) => move(index, offset)}
              onLogin={() => {
                setForm(null)
                void startLogin('codex', account.id)
              }}
              onSetKey={() => setForm({ kind: 'set-key', id: account.id })}
            />
            <LoginFlow provider="codex" accountId={account.id} label={account.label} />
            {form?.kind === 'set-key' && form.id === account.id && (
              <ApiKeyForm
                title={`API key for ${account.label}`}
                askName={false}
                onSubmit={(_label, apiKey) => submitKey(account.id, apiKey)}
                onCancel={() => setForm(null)}
              />
            )}
          </div>
        ))}

        {form?.kind === 'add-login' && (
          <NameForm
            onSubmit={async (label) => {
              const created = await addAccount(label, 'chatgpt')
              setForm(null)
              if (created) void startLogin('codex', created.id)
            }}
            onCancel={() => setForm(null)}
          />
        )}
        {form?.kind === 'add-key' && (
          <ApiKeyForm
            title="Add an account with an API key"
            askName
            onSubmit={async (label, apiKey) => {
              const created = await addAccount(label, 'apiKey')
              if (!created) return 'Could not add the account.'
              return submitKey(created.id, apiKey)
            }}
            onCancel={() => setForm(null)}
          />
        )}

        {!form && (
          <div className="flex">
            <button
              onClick={() => setForm({ kind: 'add-login' })}
              className="settings-row-action"
              data-codex-add-account
            >
              <PlusIcon className="w-4 h-4" />
              Add account
            </button>
            <button
              onClick={() => setForm({ kind: 'add-key' })}
              className="settings-row-action"
              title="An account billed by API key: the pool's fallback"
            >
              <KeyIcon className="w-4 h-4" />
              Add with an API key
            </button>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
