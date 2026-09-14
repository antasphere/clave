import { useState, type ReactElement } from 'react'
import { TrashIcon, PlusIcon, FolderIcon, KeyIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { UsageError, UsageLimits } from '../../../../preload/index.d'
import {
  useClaudeProfileStore,
  DEFAULT_CLAUDE_PROFILE_ID,
  type ClaudeProfile
} from '../../store/claude-profile-store'
import { tightestWindow, shortLabel, formatReset } from '../../store/usage-store'
import { SettingsSection, SettingsCard } from './primitives'
import { cn } from '../../lib/utils'

/** What a paste came back with, in one line under the form. */
function describeUsageResult(result: UsageLimits | UsageError): string {
  if ('error' in result) return result.error
  const tightest = tightestWindow(result.windows)
  if (!tightest) return 'Token accepted. No usage windows reported yet.'
  const left = Math.max(0, Math.round(100 - tightest.usedPercentage))
  const reset = formatReset(tightest.resetsAt)
  return `Token accepted · ${left}% left · ${shortLabel(tightest)}${reset ? ` · ${reset}` : ''}`
}

/** The paste form, for a new account or a replacement token. */
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
    <div className="px-3.5 py-3 space-y-3" data-claude-token-form>
      <div className="flex items-center justify-between">
        <p className="settings-row-title">{title}</p>
        <button
          onClick={onCancel}
          className="btn-icon btn-icon-xs"
          title="Close the form"
          aria-label="Close the form"
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>
      <p className="settings-row-description">
        In a terminal signed in to the account you want, run <code>claude setup-token</code>, finish
        the sign-in it opens in the browser, and paste the token it prints. It lasts a year, is
        stored encrypted by macOS, and only the sessions you start on this account use it. Your
        settings, plugins and history stay shared.
      </p>
      {askName && (
        <input
          className="input-field"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Account name (Work, Personal, Max 20x…)"
          aria-label="Account name"
          autoFocus
        />
      )}
      <input
        className="input-field font-mono"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        placeholder="sk-ant-oat01-…"
        aria-label="Claude Code token"
        autoComplete="off"
        spellCheck={false}
        autoFocus={!askName}
      />
      {note && (
        <p
          className={cn('text-xs', note.ok ? 'text-text-secondary' : 'text-wellbeing-strong')}
          data-claude-token-note={note.ok ? 'ok' : 'error'}
        >
          {note.text}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="btn-secondary">
          {note?.ok ? 'Done' : 'Cancel'}
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy || !token.trim() || (askName && !label.trim())}
          className="btn-primary"
        >
          {busy ? 'Checking…' : askName ? 'Add account' : 'Save token'}
        </button>
      </div>
    </div>
  )
}

function AccountRow({
  account,
  selected,
  onSelect,
  onReplaceToken
}: {
  account: ClaudeProfile
  selected: boolean
  onSelect: () => void
  onReplaceToken: () => void
}): ReactElement {
  const updateProfile = useClaudeProfileStore((s) => s.updateProfile)
  const removeProfile = useClaudeProfileStore((s) => s.removeProfile)
  const clearToken = useClaudeProfileStore((s) => s.clearToken)
  const isDefault = account.id === DEFAULT_CLAUDE_PROFILE_ID

  const pickDir = async (): Promise<void> => {
    const dir = await window.electronAPI?.openFolderDialog()
    if (dir) updateProfile(account.id, { configDir: dir })
  }

  return (
    <div className="settings-row" data-claude-account-row={account.id}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <button
          onClick={onSelect}
          title={selected ? 'Default account for new sessions' : 'Make default'}
          aria-label={
            selected ? 'Default account for new sessions' : `Make ${account.label} the default`
          }
          className={`flex-shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
            selected ? 'border-accent' : 'border-border hover:border-text-tertiary'
          }`}
        >
          {selected && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
        </button>

        <div className="flex-1 min-w-0">
          {isDefault ? (
            <p className="settings-row-title">{account.label}</p>
          ) : (
            <input
              className="input-xs w-full"
              value={account.label}
              onChange={(e) => updateProfile(account.id, { label: e.target.value })}
              placeholder="Account name"
              aria-label="Account name"
            />
          )}
          <p className="settings-row-description truncate">
            {isDefault
              ? 'Machine login · ~/.claude'
              : account.hasToken
                ? 'Token'
                : account.configDir
                  ? `Config directory · ${account.configDir}`
                  : 'No credential yet · paste a token or pick a directory'}
          </p>
        </div>
      </div>

      {!isDefault && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onReplaceToken}
            className="btn-icon btn-icon-xs"
            title={account.hasToken ? 'Replace token' : 'Paste a token'}
            aria-label={
              account.hasToken
                ? `Replace token for ${account.label}`
                : `Paste a token for ${account.label}`
            }
          >
            <KeyIcon className="w-4 h-4" />
          </button>
          {account.hasToken ? (
            <button
              onClick={() => void clearToken(account.id)}
              className="btn-icon btn-icon-xs"
              title="Forget token"
              aria-label={`Forget token for ${account.label}`}
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => void pickDir()}
              className="btn-icon btn-icon-xs"
              title={account.configDir ? 'Change directory' : 'Use a config directory instead'}
              aria-label={account.configDir ? 'Change directory' : 'Use a config directory instead'}
            >
              <FolderIcon className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => removeProfile(account.id)}
            className="btn-icon btn-icon-xs text-red-400 hover:text-red-300"
            title="Remove account"
            aria-label={`Remove account ${account.label}`}
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The Claude accounts: the machine login plus every subscription handed to
 * Clave, each with how it signs in. Lives on the Usage page under the
 * per-account windows, so the account and its headroom are read in one place.
 */
export function ClaudeAccountsSection(): ReactElement {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)
  const setSelectedProfile = useClaudeProfileStore((s) => s.setSelectedProfile)
  const addTokenProfile = useClaudeProfileStore((s) => s.addTokenProfile)
  const addProfile = useClaudeProfileStore((s) => s.addProfile)
  const setToken = useClaudeProfileStore((s) => s.setToken)
  const [form, setForm] = useState<{ kind: 'add' } | { kind: 'replace'; id: string } | null>(null)

  const addWithDirectory = async (): Promise<void> => {
    const dir = await window.electronAPI?.openFolderDialog()
    if (!dir) return
    const suggested =
      dir
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() || 'Account'
    await addProfile(suggested, dir)
  }

  return (
    <SettingsSection
      title="Claude accounts"
      description={
        <>
          Run sessions on more than one Claude subscription. Paste each account’s token once; pick
          the account when you start a session, from the launcher’s menu, a session’s menu, or an
          agent’s <code>clave_open_session</code>. The selected account is the one the keyboard
          shortcuts use.
        </>
      }
    >
      <SettingsCard>
        {profiles.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            selected={account.id === selectedProfileId}
            onSelect={() => setSelectedProfile(account.id)}
            onReplaceToken={() => setForm({ kind: 'replace', id: account.id })}
          />
        ))}

        {form?.kind === 'add' && (
          <TokenForm
            title="Add an account"
            askName
            onSubmit={async (label, token) => (await addTokenProfile(label, token)).usage}
            onCancel={() => setForm(null)}
          />
        )}
        {form?.kind === 'replace' && (
          <TokenForm
            title={`Token for ${profiles.find((p) => p.id === form.id)?.label ?? 'this account'}`}
            askName={false}
            onSubmit={(_label, token) => setToken(form.id, token)}
            onCancel={() => setForm(null)}
          />
        )}

        {!form && (
          <div className="flex">
            <button onClick={() => setForm({ kind: 'add' })} className="settings-row-action">
              <PlusIcon className="w-4 h-4" />
              Add account
            </button>
            <button
              onClick={() => void addWithDirectory()}
              className="settings-row-action"
              title="An account signed in through its own config directory (CLAUDE_CONFIG_DIR)"
            >
              <FolderIcon className="w-4 h-4" />
              Add with a config directory
            </button>
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}
