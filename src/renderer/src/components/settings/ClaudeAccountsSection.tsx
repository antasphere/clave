import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { ClipboardDocumentIcon, SparklesIcon } from '@heroicons/react/24/outline'
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
import type { AccountUsageSummary } from '../../../../shared/account-pool'
import { CLAUDE_MODELS } from '../../../../shared/claude-models'
import {
  accountUsageText,
  claudeCardFacts,
  claudeTokenLine,
  connectLabel,
  rowMenuEntries
} from './connection-cards'
import { connectAnthropic } from './connection-companies'
import { reveal } from './connection-actions'
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
import { SettingsCallout, Radio } from './primitives'
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
export function TokenForm({
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

/** The Claude models every Claude subscription serves, by name. */
const CLAUDE_MODEL_NAMES: CardModels = { names: CLAUDE_MODELS.map((model) => model.name) }

/** A Claude account as a row reads it: this Mac's or a server's. */
export interface ClaudeRowAccount {
  id: string
  label: string
  hasToken: boolean
  tokenInvalid: boolean
  tokenSetAt: number | null
  tokenExpiresAt: number | null
}

/** What a row on this Mac can do; a server's rows do none of it. */
export interface ClaudeRowControls {
  index: number
  count: number
  selected: boolean
  suggested: boolean
  onSelect: () => void
  onMove: (offset: -1 | 1) => void
  onLogin: () => void
  onPasteToken: () => void
  onRename: (label: string) => void
  onForget: () => void
  onRemove: () => void
  /** The token form, open on the row. */
  form: ReactNode
}

/**
 * One Claude account as a row of the Anthropic card (PRDCT-4552): where new
 * sessions start, its label, its sign-in in a word, its headroom. On this
 * Mac its one needed button (Sign in) stands out and everything else is in
 * its menu, in words; a server's row (`controls` absent) only reads.
 */
export function ClaudeAccountRow({
  account,
  summary,
  migrated,
  machine,
  attrs,
  controls
}: {
  account: ClaudeRowAccount
  summary: AccountUsageSummary | undefined
  migrated: boolean
  /** How the removal's question names the machine. */
  machine: string
  attrs: Record<string, string | undefined>
  controls?: ClaudeRowControls
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const isDefault = account.id === DEFAULT_CLAUDE_PROFILE_ID
  const tokenLife = describeTokenLife(account as ClaudeProfile)
  const facts = claudeCardFacts({
    id: account.id,
    hasToken: account.hasToken,
    tokenInvalid: account.tokenInvalid,
    tokenLife,
    migrated,
    isDefault,
    exhausted: isExhausted(summary)
  })
  const signIn = isDefault
    ? controls
      ? 'This Mac’s own login, ~/.claude'
      : 'The server’s own login, ~/.claude'
    : claudeTokenLine(tokenLife)
  const editable = !!controls && !isDefault
  return (
    <ConnectionRow
      {...attrs}
      data-account-exhausted={isExhausted(summary) ? 'true' : undefined}
      data-account-scoped-out={summary?.scopedOut?.length ? summary.scopedOut.join(' ') : undefined}
      pick={
        controls && (
          <Radio
            checked={controls.selected}
            onSelect={controls.onSelect}
            title={
              controls.selected ? 'Connection new sessions start on' : 'Start new sessions here'
            }
            ariaLabel={
              controls.selected
                ? 'Connection new sessions start on'
                : `Start new sessions on ${account.label}`
            }
          />
        )
      }
      heading={
        <>
          <CardLabel
            label={account.label}
            draft={draft}
            onDraft={setDraft}
            onCommit={(label) => controls?.onRename(label)}
          />
          {controls?.selected && (
            <span className="connection-row-tag" data-connection-starts-here>
              New sessions start here
            </span>
          )}
          {controls?.suggested && (
            <span className="badge account-switch-suggested" data-connection-suggested>
              <SparklesIcon aria-hidden />
              Suggested
            </span>
          )}
        </>
      }
      state={facts.state}
      stateAttrs={{ 'data-connection-state': account.id }}
      fix={
        editable &&
        facts.state.tone === 'attention' && (
          <button
            type="button"
            className="btn-secondary btn-compact"
            onClick={controls.onLogin}
            data-connection-fix={account.id}
          >
            Sign in
          </button>
        )
      }
      menu={
        editable && (
          <RowMenu
            id={account.id}
            label={account.label}
            entries={rowMenuEntries({
              kind: 'claude',
              index: controls.index,
              count: controls.count,
              signedIn: account.hasToken,
              onMove: controls.onMove,
              onRename: () => setDraft(account.label),
              onSignIn: controls.onLogin,
              onCredential: controls.onPasteToken,
              onForget: controls.onForget,
              onRemove: () => setConfirming(true),
              hooks: {
                rename: { 'data-claude-account-rename': account.id },
                signIn: { 'data-claude-account-login': account.id },
                remove: { 'data-claude-account-remove': account.id }
              }
            })}
          />
        )
      }
      lines={
        <>
          <UsageLine
            text={accountUsageText(
              capStatusLine(summary),
              !!summary,
              isDefault || (account.hasToken && !account.tokenInvalid && !migrated)
            )}
            id={account.id}
          />
          {signIn && <RowNote>{signIn}</RowNote>}
        </>
      }
      fold={
        controls && (
          <>
            <LoginFlow provider="claude" accountId={account.id} label={account.label} />
            <CardFold open={!!controls.form}>{controls.form}</CardFold>
            <CardFold open={confirming}>
              <RemoveConfirm
                kind="claude"
                label={account.label}
                machine={machine}
                id={account.id}
                onCancel={() => setConfirming(false)}
                onRemove={() => {
                  setConfirming(false)
                  controls.onRemove()
                }}
              />
            </CardFold>
          </>
        )
      }
    />
  )
}

/**
 * The Anthropic card of this Mac (PRDCT-4552): Claude Code, the Claude
 * models, then one row per connection in the order the pool walks them
 * (the machine login first); its foot connects another through the browser,
 * or with a pasted token in the card.
 */
export function ClaudeAccountsCard({ machine }: { machine: string }): ReactElement {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)
  const migratedIds = useClaudeProfileStore((s) => s.migratedIds)
  const setSelectedProfile = useClaudeProfileStore((s) => s.setSelectedProfile)
  const updateProfile = useClaudeProfileStore((s) => s.updateProfile)
  const removeProfile = useClaudeProfileStore((s) => s.removeProfile)
  const clearToken = useClaudeProfileStore((s) => s.clearToken)
  const reorderProfiles = useClaudeProfileStore((s) => s.reorderProfiles)
  const setToken = useClaudeProfileStore((s) => s.setToken)
  const addTokenProfile = useClaudeProfileStore((s) => s.addTokenProfile)
  const startLogin = useAccountLoginStore((s) => s.start)
  const [replacing, setReplacing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const byAccount = useClaudeAccountsUsage((s) => s.byAccount)
  const suggestedId = useMemo(() => {
    const pool = profiles.map((p) => ({ id: p.id, usable: claudeProfileUsable(p) }))
    if (pool.filter((p) => p.usable).length < 2) return null
    return switchTargets(pool, byAccount).find((t) => t.suggested)?.id ?? null
  }, [profiles, byAccount])
  const facts = claudeCardFacts({
    id: '',
    hasToken: false,
    tokenInvalid: false,
    tokenLife: null,
    migrated: false,
    isDefault: true
  })

  const move = (index: number, offset: -1 | 1): void => {
    const ids = profiles.filter((p) => p.id !== DEFAULT_CLAUDE_PROFILE_ID).map((p) => p.id)
    const at = index - 1
    const to = at + offset
    if (to < 0 || to >= ids.length) return
    ;[ids[at], ids[to]] = [ids[to], ids[at]]
    reorderProfiles(ids)
  }

  return (
    <ProviderCard
      company="anthropic"
      name="Anthropic"
      what="Claude subscription"
      harnesses={facts.harnesses}
      models={CLAUDE_MODEL_NAMES}
      modelsId="anthropic"
      data-provider-card="anthropic"
      data-provider-group="anthropic"
      rows={profiles.map((account, index) => (
        <ClaudeAccountRow
          key={account.id}
          account={account}
          summary={byAccount[account.id]}
          migrated={migratedIds.includes(account.id)}
          machine={machine}
          attrs={{ 'data-claude-account-row': account.id }}
          controls={{
            index,
            count: profiles.length,
            selected: account.id === selectedProfileId,
            suggested: account.id === suggestedId,
            onSelect: () => setSelectedProfile(account.id),
            onMove: (offset) => move(index, offset),
            onLogin: () => {
              setReplacing(null)
              void startLogin('claude', account.id)
            },
            onPasteToken: () => setReplacing(account.id),
            onRename: (label) => updateProfile(account.id, { label }),
            onForget: () => void clearToken(account.id),
            onRemove: () => removeProfile(account.id),
            form:
              replacing === account.id ? (
                <TokenForm
                  title={`Token for ${account.label}`}
                  askName={false}
                  onSubmit={(_label, token) => setToken(account.id, token)}
                  onCancel={() => setReplacing(null)}
                />
              ) : null
          }}
        />
      ))}
      form={
        adding ? (
          <TokenForm
            title="Add a connection with a token"
            askName
            onSubmit={async (label, token) => (await addTokenProfile(label, token)).usage}
            onCancel={() => setAdding(false)}
          />
        ) : null
      }
      foot={
        <>
          <button
            type="button"
            className="connection-card-link"
            onClick={() => {
              setAdding(true)
              reveal('[data-provider-card="anthropic"]')
            }}
            title="Paste a token from `claude setup-token` instead of signing in here"
            data-connect-secondary="anthropic"
            data-claude-paste-token
          >
            <ClipboardDocumentIcon className="w-3.5 h-3.5" />
            Paste a token
          </button>
          <button
            type="button"
            className="btn-secondary btn-compact"
            title="Sign in to Anthropic in the browser that opens"
            onClick={() =>
              void connectAnthropic().then((id) => {
                if (id) reveal(`[data-claude-account-row="${id}"]`)
              })
            }
            data-connect-company="anthropic"
            data-claude-add-account
          >
            {connectLabel(1)}
          </button>
        </>
      }
    />
  )
}

/** The Anthropic card of a Clave server: its accounts, signed in there, as
 *  rows that only read. */
export function ServerClaudeCard({
  accounts,
  migrated,
  usage,
  machine
}: {
  accounts: readonly ClaudeRowAccount[]
  migrated: readonly string[]
  usage: Record<string, AccountUsageSummary | undefined>
  machine: string
}): ReactElement {
  return (
    <ProviderCard
      company="anthropic"
      name="Anthropic"
      what="Claude subscription"
      harnesses={['claude']}
      models={CLAUDE_MODEL_NAMES}
      modelsId="server-anthropic"
      data-provider-group="anthropic"
      data-server-claude-accounts
      rows={accounts.map((account) => (
        <ClaudeAccountRow
          key={account.id}
          account={account}
          summary={usage[account.id]}
          migrated={migrated.includes(account.id)}
          machine={machine}
          attrs={{ 'data-server-claude-account': account.id }}
        />
      ))}
    />
  )
}
