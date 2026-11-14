import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import {
  TrashIcon,
  KeyIcon,
  XMarkIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ClipboardDocumentIcon,
  PencilSquareIcon,
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
import { useAccountLoginStore, loginKey } from '../../store/account-login-store'
import {
  useClaudeAccountsUsage,
  accountUsageFieldsOf,
  capStatusLine
} from '../../store/usage-store'
import { isExhausted, switchTargets } from '../../lib/account-pool'
import type { AccountUsageSummary } from '../../../../shared/account-pool'
import { CLAUDE_MODELS } from '../../../../shared/claude-models'
import { accountUsageText, claudeCardFacts, claudeTokenLine } from './connection-cards'
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
  UsageLine
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
const CLAUDE_MODEL_NAMES = CLAUDE_MODELS.map((model) => model.name)

/** A Claude account as a card reads it: this Mac's or a server's. */
export interface ClaudeCardAccount {
  id: string
  label: string
  hasToken: boolean
  tokenInvalid: boolean
  tokenSetAt: number | null
  tokenExpiresAt: number | null
}

/** What a card on this Mac can do; a server's cards do none of it. */
export interface ClaudeCardControls {
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
  /** The token form, open under the card. */
  form: ReactNode
  /** Whether a sign-in is under way or just finished, shown in the card. */
  signingIn: boolean
}

/**
 * One Claude account as a card (PRDCT-4552): its label, its sign-in in plain
 * words, Claude Code, the Claude models, its headroom. On this Mac it is
 * picked for new sessions, ordered, signed in again, renamed and removed
 * from here; a server's card (`controls` absent) only reads.
 */
export function ClaudeAccountCard({
  account,
  summary,
  migrated,
  machine,
  attrs,
  controls
}: {
  account: ClaudeCardAccount
  summary: AccountUsageSummary | undefined
  migrated: boolean
  /** How the removal's question names the machine. */
  machine: string
  /** The card's hooks for the specs and the agents' tools. */
  attrs: Record<string, string | undefined>
  controls?: ClaudeCardControls
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const isDefault = account.id === DEFAULT_CLAUDE_PROFILE_ID
  const tokenLife = describeTokenLife(account as ClaudeProfile)
  const tokenLine = claudeTokenLine(tokenLife)
  const facts = claudeCardFacts({
    id: account.id,
    hasToken: account.hasToken,
    tokenInvalid: account.tokenInvalid,
    tokenLife,
    migrated,
    isDefault
  })
  const editable = !!controls && !isDefault
  const formOpen = !!controls?.form
  const signingIn = !!controls?.signingIn
  return (
    <ConnectionCard
      tone={facts.state.tone}
      wide={formOpen || signingIn}
      {...attrs}
      data-account-exhausted={isExhausted(summary) ? 'true' : undefined}
      data-account-scoped-out={summary?.scopedOut?.length ? summary.scopedOut.join(' ') : undefined}
    >
      <CardHead
        company="anthropic"
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
          <ModelList models={{ names: CLAUDE_MODEL_NAMES }} id={account.id} />
        </CardFact>
        <CardFact term="Usage">
          <UsageLine text={accountUsageText(capStatusLine(summary), !!summary)} id={account.id} />
        </CardFact>
        {isDefault ? (
          <CardFact term="Sign-in">
            <span className="connection-card-quiet">
              {controls ? 'This Mac’s own, ~/.claude' : 'The server’s own ~/.claude'}
            </span>
          </CardFact>
        ) : (
          tokenLine && (
            <CardFact term="Sign-in">
              <span className="connection-card-quiet">{tokenLine}</span>
            </CardFact>
          )
        )}
      </CardFacts>
      {controls && (
        <>
          <LoginFlow provider="claude" accountId={account.id} label={account.label} />
          <CardFold open={formOpen}>{controls.form}</CardFold>
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
            {editable && (
              <>
                {facts.state.tone === 'attention' && (
                  <button
                    type="button"
                    className="btn-secondary btn-compact"
                    onClick={controls.onLogin}
                    data-connection-fix={account.id}
                  >
                    Sign in
                  </button>
                )}
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
                  data-claude-account-rename={account.id}
                >
                  <PencilSquareIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={controls.onLogin}
                  className="btn-icon btn-icon-sm"
                  title={account.hasToken ? 'Sign in again' : 'Sign in'}
                  aria-label={`Log in to ${account.label}`}
                  data-claude-account-login={account.id}
                >
                  <KeyIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={controls.onPasteToken}
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
                    onClick={controls.onForget}
                    className="btn-icon btn-icon-sm"
                    title="Forget token"
                    aria-label={`Forget token for ${account.label}`}
                  >
                    <XMarkIcon className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => setConfirming(true)}
                  className="btn-icon btn-icon-sm btn-icon--danger"
                  title="Remove connection"
                  aria-label={`Remove connection ${account.label}`}
                  data-claude-account-remove={account.id}
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </CardFoot>
        </>
      )}
    </ConnectionCard>
  )
}

/**
 * The Anthropic connections of this Mac as cards: the machine login plus
 * every subscription handed to Clave, in the order the pool walks them (ADR
 * 0002). New ones are made from the Anthropic card under them
 * (`ConnectionOffers`).
 */
export function ClaudeAccountCards({ machine }: { machine: string }): ReactElement {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)
  const migratedIds = useClaudeProfileStore((s) => s.migratedIds)
  const setSelectedProfile = useClaudeProfileStore((s) => s.setSelectedProfile)
  const updateProfile = useClaudeProfileStore((s) => s.updateProfile)
  const removeProfile = useClaudeProfileStore((s) => s.removeProfile)
  const clearToken = useClaudeProfileStore((s) => s.clearToken)
  const reorderProfiles = useClaudeProfileStore((s) => s.reorderProfiles)
  const setToken = useClaudeProfileStore((s) => s.setToken)
  const startLogin = useAccountLoginStore((s) => s.start)
  const jobs = useAccountLoginStore((s) => s.jobs)
  const [replacing, setReplacing] = useState<string | null>(null)
  const byAccount = useClaudeAccountsUsage((s) => s.byAccount)
  const suggestedId = useMemo(() => {
    const pool = profiles.map((p) => ({ id: p.id, usable: claudeProfileUsable(p) }))
    if (pool.filter((p) => p.usable).length < 2) return null
    return switchTargets(pool, byAccount).find((t) => t.suggested)?.id ?? null
  }, [profiles, byAccount])

  const move = (index: number, offset: -1 | 1): void => {
    const ids = profiles.filter((p) => p.id !== DEFAULT_CLAUDE_PROFILE_ID).map((p) => p.id)
    const at = index - 1
    const to = at + offset
    if (to < 0 || to >= ids.length) return
    ;[ids[at], ids[to]] = [ids[to], ids[at]]
    reorderProfiles(ids)
  }

  return (
    <>
      {profiles.map((account, index) => (
        <ClaudeAccountCard
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
            signingIn: !!jobs[loginKey('claude', account.id)],
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
    </>
  )
}
