import { useState, type ReactElement } from 'react'
import {
  TrashIcon,
  PlusIcon,
  KeyIcon,
  XMarkIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ClipboardDocumentIcon
} from '@heroicons/react/24/outline'
import type { UsageError, UsageLimits } from '../../../../preload/index.d'
import {
  useClaudeProfileStore,
  DEFAULT_CLAUDE_PROFILE_ID,
  describeClaudeProfileAuth,
  describeTokenLife,
  type ClaudeProfile
} from '../../store/claude-profile-store'
import { useAccountLoginStore } from '../../store/account-login-store'
import {
  useClaudeAccountsUsage,
  tightestWindow,
  shortLabel,
  formatReset,
  headroomLabel
} from '../../store/usage-store'
import { isExhausted } from '../../lib/account-pool'
import { ClaudeLogo } from '../icons/cli-logos'
import { SettingsSection, SettingsCard, SettingsCallout, Radio } from './primitives'
import { LoginFlow } from './LoginFlow'

/** What a paste came back with, in one line under the form. */
function describeUsageResult(result: UsageLimits | UsageError): string {
  if ('error' in result) return result.error
  const tightest = tightestWindow(result.windows)
  if (!tightest) return 'Token accepted. No usage windows reported yet.'
  const left = Math.max(0, Math.round(100 - tightest.usedPercentage))
  const reset = formatReset(tightest.resetsAt)
  return `Token accepted · ${left}% left · ${shortLabel(tightest)}${reset ? ` · ${reset}` : ''}`
}

/** The paste form, for a new account or a replacement token: the way in
 *  when the browser flow is not wanted. */
function TokenForm({
  title,
  askName,
  onSubmit,
  onCancel
}: {
  title: string
  askName: boolean
  onSubmit: (label: string, token: string) => Promise<UsageLimits | UsageError>
  onCancel: () => void
}): ReactElement {
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async (): Promise<void> => {
    if (busy || !token.trim() || (askName && !label.trim())) return
    setBusy(true)
    setNote(null)
    try {
      const result = await onSubmit(label, token)
      const ok = !('error' in result)
      setNote({ ok, text: describeUsageResult(result) })
      if (ok) setToken('')
    } catch (err) {
      setNote({
        ok: false,
        text: err instanceof Error ? err.message : 'Could not store the token.'
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-claude-token-form>
      <SettingsCallout
        inset
        tone="accent"
        title={title}
        text={
          <>
            Run <code>claude setup-token</code> in a terminal signed in to that account and paste
            the token it prints. Only sessions started on this account use it; your settings,
            plugins and history stay shared.
          </>
        }
        actions={
          <>
            <button onClick={onCancel} className="btn-secondary">
              {note?.ok ? 'Done' : 'Cancel'}
            </button>
            <button
              onClick={() => void submit()}
              disabled={busy || !token.trim() || (askName && !label.trim())}
              className="btn-primary"
            >
              {askName ? 'Add account' : 'Save token'}
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
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="sk-ant-oat01-…"
            aria-label="Claude Code token"
            autoFocus={!askName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
          {note && (
            <p
              className={note.ok ? 'text-xs text-text-secondary' : 'text-xs text-destructive'}
              data-claude-token-note={note.ok ? 'ok' : 'error'}
            >
              {note.text}
            </p>
          )}
        </div>
      </SettingsCallout>
    </div>
  )
}

/** The name form for an account that will sign in through the browser. */
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
    <div data-claude-name-form>
      <SettingsCallout
        inset
        tone="accent"
        title="Add an account"
        text="Name the subscription, then sign in to it in the browser that opens. The token Claude prints is stored here, encrypted, and never shown."
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

function AccountRow({
  account,
  index,
  count,
  selected,
  migrated,
  onSelect,
  onMove,
  onLogin,
  onPasteToken
}: {
  account: ClaudeProfile
  index: number
  count: number
  selected: boolean
  migrated: boolean
  onSelect: () => void
  onMove: (offset: -1 | 1) => void
  onLogin: () => void
  onPasteToken: () => void
}): ReactElement {
  const updateProfile = useClaudeProfileStore((s) => s.updateProfile)
  const removeProfile = useClaudeProfileStore((s) => s.removeProfile)
  const clearToken = useClaudeProfileStore((s) => s.clearToken)
  const summary = useClaudeAccountsUsage((s) => s.byAccount[account.id])
  const isDefault = account.id === DEFAULT_CLAUDE_PROFILE_ID
  const life = describeTokenLife(account)
  const headroom = headroomLabel(summary)
  const description = [
    isDefault ? 'Machine login · ~/.claude' : describeClaudeProfileAuth(account),
    life,
    headroom,
    isExhausted(summary) ? 'at limit' : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="settings-row"
      data-claude-account-row={account.id}
      data-account-exhausted={isExhausted(summary) ? 'true' : undefined}
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
                onChange={(e) => updateProfile(account.id, { label: e.target.value })}
                placeholder="Account name"
                aria-label="Account name"
              />
            )}
            {(migrated || (!isDefault && !account.hasToken)) && (
              <span className="badge badge-muted flex-shrink-0">Needs login</span>
            )}
            {account.tokenInvalid && (
              <span className="badge badge-muted flex-shrink-0">Token refused</span>
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
            <button
              onClick={onLogin}
              className="btn-icon btn-icon-sm"
              title={account.hasToken ? 'Log in again' : 'Log in'}
              aria-label={`Log in to ${account.label}`}
              data-claude-account-login={account.id}
            >
              <KeyIcon className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onPasteToken}
              className="btn-icon btn-icon-sm"
              title={account.hasToken ? 'Replace the token by pasting one' : 'Paste a token'}
              aria-label={
                account.hasToken
                  ? `Replace token for ${account.label}`
                  : `Paste a token for ${account.label}`
              }
            >
              <ClipboardDocumentIcon className="w-3.5 h-3.5" />
            </button>
            {account.hasToken && (
              <button
                onClick={() => void clearToken(account.id)}
                className="btn-icon btn-icon-sm"
                title="Forget token"
                aria-label={`Forget token for ${account.label}`}
              >
                <XMarkIcon className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => removeProfile(account.id)}
              className="btn-icon btn-icon-sm btn-icon--danger"
              title="Remove account"
              aria-label={`Remove account ${account.label}`}
            >
              <TrashIcon className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The Claude accounts: the machine login plus every subscription handed to
 * Clave, in the order the pool walks them (ADR 0002). An account is signed
 * in through the browser, or by pasting a `claude setup-token` token.
 */
export function ClaudeAccountsSection(): ReactElement {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)
  const migratedIds = useClaudeProfileStore((s) => s.migratedIds)
  const setSelectedProfile = useClaudeProfileStore((s) => s.setSelectedProfile)
  const addTokenProfile = useClaudeProfileStore((s) => s.addTokenProfile)
  const addProfile = useClaudeProfileStore((s) => s.addProfile)
  const reorderProfiles = useClaudeProfileStore((s) => s.reorderProfiles)
  const setToken = useClaudeProfileStore((s) => s.setToken)
  const startLogin = useAccountLoginStore((s) => s.start)
  const [form, setForm] = useState<
    { kind: 'add-login' } | { kind: 'add-token' } | { kind: 'replace'; id: string } | null
  >(null)

  const move = (index: number, offset: -1 | 1): void => {
    const ids = profiles.filter((p) => p.id !== DEFAULT_CLAUDE_PROFILE_ID).map((p) => p.id)
    const at = index - 1
    const to = at + offset
    if (to < 0 || to >= ids.length) return
    ;[ids[at], ids[to]] = [ids[to], ids[at]]
    reorderProfiles(ids)
  }

  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-2">
          <ClaudeLogo className="w-4 h-4 text-text-tertiary" />
          Claude
        </span>
      }
      description="New Claude sessions start on the selected account and move along this list when it is about to hit its limit. Every account shares ~/.claude, so a conversation can carry on under another."
    >
      <SettingsCard>
        {profiles.map((account, index) => (
          <div key={account.id}>
            <AccountRow
              account={account}
              index={index}
              count={profiles.length}
              selected={account.id === selectedProfileId}
              migrated={migratedIds.includes(account.id)}
              onSelect={() => setSelectedProfile(account.id)}
              onMove={(offset) => move(index, offset)}
              onLogin={() => {
                setForm(null)
                void startLogin('claude', account.id)
              }}
              onPasteToken={() => setForm({ kind: 'replace', id: account.id })}
            />
            <LoginFlow provider="claude" accountId={account.id} label={account.label} />
            {form?.kind === 'replace' && form.id === account.id && (
              <TokenForm
                title={`Token for ${account.label}`}
                askName={false}
                onSubmit={(_label, token) => setToken(account.id, token)}
                onCancel={() => setForm(null)}
              />
            )}
          </div>
        ))}

        {form?.kind === 'add-login' && (
          <NameForm
            onSubmit={async (label) => {
              const created = await addProfile(label)
              setForm(null)
              if (created) void startLogin('claude', created.id)
            }}
            onCancel={() => setForm(null)}
          />
        )}
        {form?.kind === 'add-token' && (
          <TokenForm
            title="Add an account with a token"
            askName
            onSubmit={async (label, token) => (await addTokenProfile(label, token)).usage}
            onCancel={() => setForm(null)}
          />
        )}

        {!form && (
          <div className="flex">
            <button
              onClick={() => setForm({ kind: 'add-login' })}
              className="settings-row-action"
              data-claude-add-account
            >
              <PlusIcon className="w-4 h-4" />
              Add account
            </button>
            <button
              onClick={() => setForm({ kind: 'add-token' })}
              className="settings-row-action"
              title="Paste a token from `claude setup-token` instead of signing in here"
            >
              <ClipboardDocumentIcon className="w-4 h-4" />
              Add with a token
            </button>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
