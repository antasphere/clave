import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { KeyIcon, SparklesIcon } from '@heroicons/react/24/outline'
import {
  useCodexAccountStore,
  DEFAULT_CODEX_ACCOUNT_ID,
  codexAccountUsable
} from '../../store/codex-account-store'
import type { CodexAccount } from '../../../../preload/index.d'
import { useAccountLoginStore, loginKey } from '../../store/account-login-store'
import { useCodexAccountsUsage, capStatusLine } from '../../store/usage-store'
import { isExhausted, switchTargets } from '../../lib/account-pool'
import type { AccountUsageSummary } from '../../../../shared/account-pool'
import { accountUsageText, codexCardFacts, connectLabel, rowMenuEntries } from './connection-cards'
import { codexAccountShown, reveal, submitCodexKey } from './connection-actions'
import { connectOpenAI } from './connection-companies'
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

/** The API-key form: a new account, or a key for an existing one. */
export function ApiKeyForm({
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
        text="An API key bills usage instead of a subscription, so it has no limit to read: the pool only falls back to it when every subscription connection is out."
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
              {askName ? 'Add connection' : 'Save key'}
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

/** The form to add a Codex connection with an API key (the pool's fallback). */
export function NewCodexKeyForm({ onClose }: { onClose: () => void }): ReactElement {
  const addAccount = useCodexAccountStore((s) => s.addAccount)
  return (
    <ApiKeyForm
      title="Add a connection with an API key"
      askName
      onSubmit={async (label, apiKey) => {
        const created = await addAccount(label, 'apiKey')
        if (!created) return 'Could not add the connection.'
        return submitCodexKey(created.id, apiKey)
      }}
      onCancel={onClose}
    />
  )
}

/** What a row on this Mac can do; a server's rows do none of it. */
export interface CodexRowControls {
  index: number
  count: number
  selected: boolean
  suggested: boolean
  onSelect: () => void
  onMove: (offset: -1 | 1) => void
  onLogin: () => void
  onSetKey: () => void
  onRename: (label: string) => void
  onForget: () => void
  onRemove: () => void
  form: ReactNode
}

/**
 * One Codex account as a row of the OpenAI card (PRDCT-4552): a ChatGPT
 * subscription signed in through the browser, or a key billed per use (the
 * pool's fallback). On this Mac its one needed button stands out and
 * everything else is in its menu; a server's row (`controls` absent) only
 * reads.
 */
export function CodexAccountRow({
  account,
  summary,
  machine,
  attrs,
  controls
}: {
  account: CodexAccount
  summary: AccountUsageSummary | undefined
  machine: string
  attrs: Record<string, string | undefined>
  controls?: CodexRowControls
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const isDefault = account.id === DEFAULT_CODEX_ACCOUNT_ID
  const apiKey = account.kind === 'apiKey'
  const facts = codexCardFacts({
    id: account.id,
    kind: account.kind,
    hasCredential: account.hasCredential,
    isDefault,
    exhausted: !apiKey && isExhausted(summary)
  })
  return (
    <ConnectionRow
      {...attrs}
      data-account-exhausted={!apiKey && isExhausted(summary) ? 'true' : undefined}
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
        controls &&
        facts.state.tone === 'attention' && (
          <button
            type="button"
            className="btn-secondary btn-compact"
            onClick={apiKey ? controls.onSetKey : controls.onLogin}
            data-connection-fix={account.id}
          >
            {apiKey ? 'Paste the key' : 'Sign in'}
          </button>
        )
      }
      menu={
        controls && (
          <RowMenu
            id={account.id}
            label={account.label}
            entries={rowMenuEntries({
              kind: apiKey ? 'codex-key' : 'codex-chatgpt',
              isDefault,
              index: controls.index,
              count: controls.count,
              signedIn: account.hasCredential,
              onMove: controls.onMove,
              onRename: () => setDraft(account.label),
              onSignIn: controls.onLogin,
              onCredential: controls.onSetKey,
              onForget: controls.onForget,
              onRemove: () => setConfirming(true),
              hooks: {
                rename: { 'data-codex-account-rename': account.id },
                signIn: { 'data-codex-account-login': account.id },
                credential: { 'data-codex-account-login': account.id },
                remove: { 'data-codex-account-remove': account.id }
              }
            })}
          />
        )
      }
      lines={
        <>
          <UsageLine
            text={
              apiKey
                ? 'Pay per use'
                : accountUsageText(capStatusLine(summary), !!summary, account.hasCredential)
            }
            id={account.id}
          />
          {isDefault && (
            <RowNote>
              {controls ? 'This Mac’s own login, ~/.codex' : 'The server’s own login, ~/.codex'}
            </RowNote>
          )}
        </>
      }
      fold={
        controls && (
          <>
            <LoginFlow provider="codex" accountId={account.id} label={account.label} />
            <CardFold open={!!controls.form}>{controls.form}</CardFold>
            <CardFold open={confirming}>
              <RemoveConfirm
                kind={apiKey ? 'codex-key' : 'codex-chatgpt'}
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
 * The OpenAI card of this Mac (PRDCT-4552), drawn once a Codex connection is
 * there: Codex, its models, one row per connection in the pool's order (the
 * machine's own `~/.codex` once it is signed in), and a foot that connects
 * another through the browser or with an API key in the card.
 */
export function CodexAccountsCard({
  machine,
  models
}: {
  machine: string
  models: CardModels
}): ReactElement {
  const accounts = useCodexAccountStore((s) => s.accounts)
  const selectedAccountId = useCodexAccountStore((s) => s.selectedAccountId)
  const setSelectedAccount = useCodexAccountStore((s) => s.setSelectedAccount)
  const updateAccount = useCodexAccountStore((s) => s.updateAccount)
  const removeAccount = useCodexAccountStore((s) => s.removeAccount)
  const clearCredential = useCodexAccountStore((s) => s.clearCredential)
  const reorderAccounts = useCodexAccountStore((s) => s.reorderAccounts)
  const startLogin = useAccountLoginStore((s) => s.start)
  const jobs = useAccountLoginStore((s) => s.jobs)
  const [settingKey, setSettingKey] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const byAccount = useCodexAccountsUsage((s) => s.byAccount)
  const suggestedId = useMemo(() => {
    const pool = accounts.map((a) => ({
      id: a.id,
      usable: codexAccountUsable(a),
      fallback: a.kind === 'apiKey'
    }))
    if (pool.filter((p) => p.usable).length < 2) return null
    return switchTargets(pool, byAccount).find((t) => t.suggested)?.id ?? null
  }, [accounts, byAccount])

  const move = (index: number, offset: -1 | 1): void => {
    const ids = accounts.filter((a) => a.id !== DEFAULT_CODEX_ACCOUNT_ID).map((a) => a.id)
    const at = index - 1
    const to = at + offset
    if (to < 0 || to >= ids.length) return
    ;[ids[at], ids[to]] = [ids[to], ids[at]]
    reorderAccounts(ids)
  }

  return (
    <ProviderCard
      company="openai"
      name="OpenAI"
      what="ChatGPT subscription"
      harnesses={['codex']}
      models={models}
      modelsId="openai"
      data-provider-card="openai"
      data-provider-group="openai"
      rows={accounts.map((account, index) =>
        codexAccountShown(account) || jobs[loginKey('codex', account.id)] ? (
          <CodexAccountRow
            key={account.id}
            account={account}
            summary={byAccount[account.id]}
            machine={machine}
            attrs={{ 'data-codex-account-row': account.id }}
            controls={{
              index,
              count: accounts.length,
              selected: account.id === selectedAccountId,
              suggested: account.id === suggestedId,
              onSelect: () => setSelectedAccount(account.id),
              onMove: (offset) => move(index, offset),
              onLogin: () => {
                setSettingKey(null)
                void startLogin('codex', account.id)
              },
              onSetKey: () => setSettingKey(account.id),
              onRename: (label) => updateAccount(account.id, { label }),
              onForget: () => void clearCredential(account.id),
              onRemove: () => removeAccount(account.id),
              form:
                settingKey === account.id ? (
                  <ApiKeyForm
                    title={`Key for ${account.label}`}
                    askName={false}
                    onSubmit={(_label, apiKey) => submitCodexKey(account.id, apiKey)}
                    onCancel={() => setSettingKey(null)}
                  />
                ) : null
            }}
          />
        ) : null
      )}
      form={adding ? <NewCodexKeyForm onClose={() => setAdding(false)} /> : null}
      foot={
        <>
          <button
            type="button"
            className="connection-card-link"
            onClick={() => {
              setAdding(true)
              reveal('[data-provider-card="openai"]')
            }}
            title="A connection billed per use: the pool's fallback"
            data-connect-secondary="openai"
            data-codex-api-key
          >
            <KeyIcon className="w-3.5 h-3.5" />
            Use an API key
          </button>
          <button
            type="button"
            className="btn-secondary btn-compact"
            title="Sign in to OpenAI in the browser that opens"
            onClick={() =>
              void connectOpenAI().then((id) => {
                if (id) reveal(`[data-codex-account-row="${id}"]`)
              })
            }
            data-connect-company="openai"
            data-codex-add-account
          >
            {connectLabel(1)}
          </button>
        </>
      }
    />
  )
}

/** The OpenAI card of a Clave server: its Codex accounts, signed in there,
 *  as rows that only read. */
export function ServerCodexCard({
  accounts,
  usage,
  models,
  machine
}: {
  accounts: readonly CodexAccount[]
  usage: Record<string, AccountUsageSummary | undefined>
  models: CardModels
  machine: string
}): ReactElement {
  return (
    <ProviderCard
      company="openai"
      name="OpenAI"
      what="ChatGPT subscription"
      harnesses={['codex']}
      models={models}
      modelsId="server-openai"
      data-provider-group="openai"
      data-server-codex-accounts
      rows={
        accounts.length === 0 ? (
          <p className="connection-row-empty">No Codex account is signed in on {machine} yet.</p>
        ) : (
          accounts.map((account) => (
            <CodexAccountRow
              key={account.id}
              account={account}
              summary={usage[account.id]}
              machine={machine}
              attrs={{ 'data-server-codex-account': account.id }}
            />
          ))
        )
      }
    />
  )
}
