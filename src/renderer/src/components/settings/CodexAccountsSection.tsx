import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import {
  TrashIcon,
  KeyIcon,
  XMarkIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  PencilSquareIcon,
  SparklesIcon
} from '@heroicons/react/24/outline'
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
import { accountUsageText, codexCardFacts } from './connection-cards'
import { codexAccountShown, submitCodexKey } from './connection-actions'
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

/** What a card on this Mac can do; a server's cards do none of it. */
export interface CodexCardControls {
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
  signingIn: boolean
}

/**
 * One Codex account as a card (PRDCT-4552): a ChatGPT subscription signed in
 * through the browser, or a key billed per use (the pool's fallback). On this
 * Mac it is picked, ordered, signed in again, renamed and removed from here;
 * a server's card (`controls` absent) only reads.
 */
export function CodexAccountCard({
  account,
  summary,
  models,
  machine,
  attrs,
  controls
}: {
  account: CodexAccount
  summary: AccountUsageSummary | undefined
  models: CardModels
  machine: string
  attrs: Record<string, string | undefined>
  controls?: CodexCardControls
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const isDefault = account.id === DEFAULT_CODEX_ACCOUNT_ID
  const apiKey = account.kind === 'apiKey'
  const facts = codexCardFacts({
    id: account.id,
    kind: account.kind,
    hasCredential: account.hasCredential,
    isDefault
  })
  const formOpen = !!controls?.form
  const signingIn = !!controls?.signingIn
  return (
    <ConnectionCard
      tone={facts.state.tone}
      wide={formOpen || signingIn}
      {...attrs}
      data-account-exhausted={!apiKey && isExhausted(summary) ? 'true' : undefined}
    >
      <CardHead
        company="openai"
        title={
          <>
            <CardLabel
              label={account.label}
              draft={draft}
              onDraft={setDraft}
              onCommit={(label) => controls?.onRename(label)}
            />
            {controls?.suggested && (
              <span className="badge account-switch-suggested" data-connection-suggested>
                <SparklesIcon aria-hidden />
                Suggested
              </span>
            )}
          </>
        }
        subtitle={<CompanyWhat company={facts.companyName} what={facts.what} />}
        aside={<CardStateText state={facts.state} data-connection-state={account.id} />}
      />
      <CardFacts>
        <CardFact term="Harnesses">
          <HarnessList harnesses={facts.harnesses} />
        </CardFact>
        <CardFact term="Models">
          <ModelList models={models} id={account.id} />
        </CardFact>
        <CardFact term="Usage">
          <UsageLine
            text={apiKey ? 'Pay per use' : accountUsageText(capStatusLine(summary), !!summary)}
            id={account.id}
          />
        </CardFact>
        {isDefault && (
          <CardFact term="Sign-in">
            <span className="connection-card-quiet">
              {controls ? 'This Mac’s own, ~/.codex' : 'The server’s own ~/.codex'}
            </span>
          </CardFact>
        )}
      </CardFacts>
      {controls && (
        <>
          <LoginFlow provider="codex" accountId={account.id} label={account.label} />
          <CardFold open={formOpen}>{controls.form}</CardFold>
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
          <CardFoot
            hidden={confirming || formOpen}
            start={
              <label className="connection-card-pick">
                <Radio
                  checked={controls.selected}
                  onSelect={controls.onSelect}
                  title={
                    controls.selected
                      ? 'Connection new sessions start on'
                      : 'Start new sessions here'
                  }
                  ariaLabel={
                    controls.selected
                      ? 'Connection new sessions start on'
                      : `Start new sessions on ${account.label}`
                  }
                />
                <span>
                  {controls.selected ? 'New sessions start here' : 'Start new sessions here'}
                </span>
              </label>
            }
          >
            {facts.state.tone === 'attention' && (
              <button
                type="button"
                className="btn-secondary btn-compact"
                onClick={apiKey ? controls.onSetKey : controls.onLogin}
                data-connection-fix={account.id}
              >
                {apiKey ? 'Paste the key' : 'Sign in'}
              </button>
            )}
            {!isDefault && (
              <>
                <button
                  onClick={() => controls.onMove(-1)}
                  disabled={controls.index <= 1}
                  className="btn-icon btn-icon-sm"
                  title="Earlier in the pool"
                  aria-label={`Move ${account.label} up`}
                >
                  <ArrowUpIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => controls.onMove(1)}
                  disabled={controls.index >= controls.count - 1}
                  className="btn-icon btn-icon-sm"
                  title="Later in the pool"
                  aria-label={`Move ${account.label} down`}
                >
                  <ArrowDownIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setDraft(account.label)}
                  className="btn-icon btn-icon-sm"
                  title="Rename"
                  aria-label={`Rename ${account.label}`}
                  data-codex-account-rename={account.id}
                >
                  <PencilSquareIcon className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            <button
              onClick={apiKey ? controls.onSetKey : controls.onLogin}
              className="btn-icon btn-icon-sm"
              title={
                apiKey
                  ? account.hasCredential
                    ? 'Replace the key'
                    : 'Set the key'
                  : account.hasCredential
                    ? 'Sign in again'
                    : 'Sign in'
              }
              aria-label={`Log in to ${account.label}`}
              data-codex-account-login={account.id}
            >
              <KeyIcon className="w-3.5 h-3.5" />
            </button>
            {!isDefault && account.hasCredential && (
              <button
                onClick={controls.onForget}
                className="btn-icon btn-icon-sm"
                title="Forget credential"
                aria-label={`Forget credential for ${account.label}`}
              >
                <XMarkIcon className="w-3.5 h-3.5" />
              </button>
            )}
            {!isDefault && (
              <button
                onClick={() => setConfirming(true)}
                className="btn-icon btn-icon-sm btn-icon--danger"
                title="Remove connection"
                aria-label={`Remove connection ${account.label}`}
                data-codex-account-remove={account.id}
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </CardFoot>
        </>
      )}
    </ConnectionCard>
  )
}

/**
 * The OpenAI connections of this Mac as cards: the machine's own `~/.codex`
 * once signed in, plus every subscription or key handed to Clave, each a
 * home of its own (ADR 0002), in the order the pool walks them.
 */
export function CodexAccountCards({
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
    <>
      {accounts.map((account, index) =>
        codexAccountShown(account) || jobs[loginKey('codex', account.id)] ? (
          <CodexAccountCard
            key={account.id}
            account={account}
            summary={byAccount[account.id]}
            models={models}
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
              signingIn: !!jobs[loginKey('codex', account.id)],
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
    </>
  )
}
