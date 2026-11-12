import { useMemo, useState, type ReactElement } from 'react'
import {
  TrashIcon,
  PlusIcon,
  KeyIcon,
  XMarkIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ClipboardDocumentIcon,
  SparklesIcon
} from '@heroicons/react/24/outline'
import type { UsageError, UsageLimits } from '../../../../preload/index.d'
import {
  useClaudeProfileStore,
  DEFAULT_CLAUDE_PROFILE_ID,
  claudeProfileUsable,
  describeTokenLife,
  type ClaudeProfile
} from '../../store/claude-profile-store'
import { useAccountLoginStore } from '../../store/account-login-store'
import {
  useClaudeAccountsUsage,
  accountUsageFieldsOf,
  capStatusLine
} from '../../store/usage-store'
import { isExhausted, switchTargets } from '../../lib/account-pool'
import { CONNECTION_COMPANY_BY_POOL } from './connection-companies'
import { SettingsSection, SettingsCard, SettingsCallout, Radio } from './primitives'
import { LoginFlow } from './LoginFlow'

/** What a paste came back with, in one line under the form. */
function describeUsageResult(result: UsageLimits | UsageError): string {
  if ('error' in result) return result.error
  // The account view: the shared headroom, then every family that is out.
  const line = capStatusLine({
    status: 'ready',
    error: null,
    ...accountUsageFieldsOf(result.windows)
  })
  if (!line) return 'Token accepted. No usage windows reported yet.'
  return `Token accepted · ${line}`
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
            Run <code>claude setup-token</code> in a terminal signed in to that subscription and
            paste the token it prints. Only sessions started on this connection use it; your
            settings, plugins and history stay shared.
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
              {askName ? 'Add connection' : 'Save token'}
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
              placeholder="Connection name"
              aria-label="Connection name"
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
        title="Add a connection"
        text="Name the subscription, then sign in to it in the browser that opens. What Claude hands back is stored here, encrypted, and never shown."
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
          placeholder="Connection name"
          aria-label="Connection name"
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
  suggested,
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
  /** The open connection the pool would spend first (its week renews soonest). */
  suggested: boolean
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
  const { Logo } = CONNECTION_COMPANY_BY_POOL.claude
  // The shared headroom first, then every family that is out, named with
  // its return ("60% left · Overall · Fable out · back in 2d 5h"): a family
  // week spent is not the account out (PRDCT-4253, PRDCT-4254). How the
  // connection signs in is never on the card (PRDCT-4424): only the Mac's own
  // login says where it lives.
  const description = [isDefault ? 'Machine login · ~/.claude' : null, life, capStatusLine(summary)]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="settings-row"
      data-claude-account-row={account.id}
      data-account-exhausted={isExhausted(summary) ? 'true' : undefined}
      data-account-scoped-out={summary?.scopedOut?.length ? summary.scopedOut.join(' ') : undefined}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Radio
          checked={selected}
          onSelect={onSelect}
          title={selected ? 'Connection new sessions start on' : 'Start new sessions here'}
          ariaLabel={
            selected ? 'Connection new sessions start on' : `Start new sessions on ${account.label}`
          }
        />
        <Logo className="w-4 h-4 flex-shrink-0 text-text-tertiary" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {isDefault ? (
              <p className="settings-row-title">{account.label}</p>
            ) : (
              <input
                className="input-compact w-full max-w-56"
                value={account.label}
                onChange={(e) => updateProfile(account.id, { label: e.target.value })}
                placeholder="Connection name"
                aria-label="Connection name"
              />
            )}
            {suggested && (
              <span className="badge account-switch-suggested" data-connection-suggested>
                <SparklesIcon aria-hidden />
                Suggested
              </span>
            )}
            {(migrated || (!isDefault && !account.hasToken)) && (
              <span className="badge badge-muted flex-shrink-0">Needs login</span>
            )}
            {account.tokenInvalid && (
              <span className="badge badge-muted flex-shrink-0">Sign-in refused</span>
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
              title="Remove connection"
              aria-label={`Remove connection ${account.label}`}
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
 * The Anthropic connections: the machine login plus every subscription
 * handed to Clave, in the order the pool walks them (ADR 0002). A connection
 * is signed in through the browser, or by pasting a `claude setup-token`
 * token. `pasteRequest` opens the paste form from the page's Connect chooser
 * (a new number each time it is asked).
 */
export function ClaudeAccountsSection({
  pasteRequest = 0
}: { pasteRequest?: number } = {}): ReactElement {
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
  // The chooser's "Paste a token instead": derived during render, the
  // React-sanctioned shape, rather than a setState inside an effect.
  const [seenPaste, setSeenPaste] = useState(pasteRequest)
  if (seenPaste !== pasteRequest) {
    setSeenPaste(pasteRequest)
    if (pasteRequest > 0) setForm({ kind: 'add-token' })
  }
  const byAccount = useClaudeAccountsUsage((s) => s.byAccount)
  const suggestedId = useMemo(() => {
    const pool = profiles.map((p) => ({ id: p.id, usable: claudeProfileUsable(p) }))
    if (pool.filter((p) => p.usable).length < 2) return null
    return switchTargets(pool, byAccount).find((t) => t.suggested)?.id ?? null
  }, [profiles, byAccount])
  const company = CONNECTION_COMPANY_BY_POOL.claude

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
          <company.Logo className="w-4 h-4 text-text-tertiary" />
          {company.name}
        </span>
      }
      description={`${company.hint} New Claude sessions start on the selected connection and move along this list when it is about to hit its limit. Every connection shares ~/.claude, so a conversation can carry on under another.`}
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
              suggested={account.id === suggestedId}
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
            title="Add a connection with a token"
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
              Add connection
            </button>
            <button
              onClick={() => setForm({ kind: 'add-token' })}
              className="settings-row-action"
              title="Paste a token from `claude setup-token` instead of signing in here"
              data-claude-paste-token
            >
              <ClipboardDocumentIcon className="w-4 h-4" />
              Paste a token instead
            </button>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
