import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { ArrowDownTrayIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type {
  SlidelessAccounts,
  SlidelessLogin,
  SlidelessProfile,
  SlidelessSignIn
} from '@clave/contract/artefacts/model'
import { cn } from '@clave/ui/components'
import { initArtefacts, useArtefactStore } from '../../store/artefact-store'
import { useSessionStore } from '../../store/session-store'
import {
  actionOf,
  behindLine,
  checkLine,
  environmentLines,
  hostOf,
  normalOrigin,
  offersPastedKey,
  prefilledAddress,
  prefilledHub,
  profileAt,
  profileTitle,
  refusalText,
  signInLine,
  signInStatus
} from '../../lib/slideless-accounts'
import {
  SettingsCallout,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect
} from './primitives'

/**
 * Settings › Slideless (PRDCT-4266), a page of the Agents group: the
 * Slideless sites the machine the picker names signs in to, as that
 * machine's own copy of the command lists them, and where its new links go.
 * The same component draws this Mac's page and a server's (`ServerPages.tsx`
 * wraps it with the server's notice), the machine a prop.
 *
 * On open the plain listing is drawn at once, then each sign-in is tried on
 * its site (`--check`), and again whenever the Settings view is shown again
 * (it stays mounted under the others); Refresh tries them again. Each site is a row keyed by
 * its origin, saying only what is known of it, with the one action its fix
 * offers: a sign-in with an e-mail code, a key to paste, a check, a removal.
 * A sign-in code and a key live in the form that asks for them and nowhere
 * else: cleared once given, gone with the form. Every call answers the
 * listing again, and the newest answer asked is the one on screen.
 */

const api = (): Window['electronAPI']['artefacts'] => window.electronAPI.artefacts
/** The server a call goes to: none for this Mac. */
const serverIdOf = (machine: string): string | undefined =>
  machine === LOCAL_SERVER_ID ? undefined : machine
/** The select's entry for « New links go to » when none is named. */
const NOT_CHOSEN = '__not-chosen__'

interface AccountsView {
  readonly machine: string
  /** The listing on screen; null until the first answer. */
  readonly accounts: SlidelessAccounts | null
  /** Why the machine did not answer at all, when it did not. */
  readonly failure: string | null
  /** A check is running: the rows read « Checking… ». */
  readonly checking: boolean
  /** Puts the listing a call answers on screen, unless a newer call's is there already. */
  readonly run: (call: () => Promise<SlidelessAccounts>) => Promise<SlidelessAccounts>
  /** Tries every sign-in on its site: the page's check (its failure said at the
   *  top), or a row's fix that runs it (its failure thrown to the row). */
  readonly check: (call?: () => Promise<SlidelessAccounts>) => Promise<void>
  /** The plain listing again. */
  readonly read: () => Promise<void>
  /** The plain listing, then the check: what the page does on open. */
  readonly reload: () => Promise<void>
}

/** One machine's listing, as the page shows it. Mounted per machine (the
 *  page is keyed by it), so a machine picked anew starts empty. */
function useAccounts(machine: string, live: boolean): AccountsView {
  const [accounts, setAccounts] = useState<SlidelessAccounts | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [checks, setChecks] = useState(0)
  /** The calls asked and the one on screen, by the order they were asked. */
  const order = useRef({ asked: 0, shown: 0, mounted: true })

  const run = useCallback(async (call: () => Promise<SlidelessAccounts>) => {
    const n = ++order.current.asked
    const listing = await call()
    if (order.current.mounted && n > order.current.shown) {
      order.current.shown = n
      setAccounts(listing)
      setFailure(null)
    }
    return listing
  }, [])

  const check = useCallback(
    async (call?: () => Promise<SlidelessAccounts>) => {
      setChecks((count) => count + 1)
      try {
        await run(call ?? (() => api().checkSlidelessAccounts(serverIdOf(machine))))
      } catch (error) {
        // A row's own fix says its refusal on its row; the page's check, at the top.
        if (call) throw error
        if (order.current.mounted) setFailure(refusalText(error))
      } finally {
        if (order.current.mounted) setChecks((count) => count - 1)
      }
    },
    [machine, run]
  )

  const read = useCallback(async () => {
    try {
      await run(() => api().slidelessAccounts(serverIdOf(machine)))
    } catch (error) {
      if (order.current.mounted) setFailure(refusalText(error))
    }
  }, [machine, run])

  const reload = useCallback(async () => {
    let listing: SlidelessAccounts
    try {
      listing = await run(() => api().slidelessAccounts(serverIdOf(machine)))
    } catch (error) {
      if (order.current.mounted) setFailure(refusalText(error))
      return
    }
    // A machine whose accounts cannot be listed has nothing to check.
    if (listing.error === null) await check()
  }, [machine, run, check])

  useEffect(() => {
    const state = order.current
    state.mounted = true
    if (live) void reload()
    return () => {
      state.mounted = false
    }
  }, [live, reload])

  return { machine, accounts, failure, checking: checks > 0, run, check, read, reload }
}

/** Settings › Slideless for this Mac, or for the server `machine` names. */
export function SlidelessSettings({
  machine = LOCAL_SERVER_ID,
  notice,
  live = true
}: {
  machine?: string
  /** What the page says while its server is not there to answer (a server's page). */
  notice?: ReactNode
  /** Whether the machine answers: a server not connected draws its notice alone. */
  live?: boolean
}): ReactElement {
  return <AccountsPage key={`${machine}:${live}`} machine={machine} notice={notice} live={live} />
}

function AccountsPage({
  machine,
  notice,
  live
}: {
  machine: string
  notice?: ReactNode
  live: boolean
}): ReactElement {
  const view = useAccounts(machine, live)
  // The Settings view stays mounted while another is shown: shown again, the
  // page lists and checks again, as on open, its open forms kept.
  const shown = useSessionStore((s) => s.activeView === 'settings')
  const wasShown = useRef(shown)
  const { reload } = view
  useEffect(() => {
    const before = wasShown.current
    wasShown.current = shown
    if (shown && !before && live) void reload()
  }, [shown, live, reload])
  return (
    <SettingsPage
      title="Slideless"
      description="The Slideless sites this machine signs in to, and where new links go."
      testId="slideless"
      actions={
        live ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void view.check()}
            disabled={view.checking}
            title="Try every sign-in on its site again"
            data-slideless-refresh
          >
            <ArrowPathIcon className={cn('w-3.5 h-3.5', view.checking && 'animate-spin')} />
            Refresh
          </button>
        ) : undefined
      }
    >
      {notice}
      {live && <AccountsBody view={view} />}
    </SettingsPage>
  )
}

/** Install the latest Slideless on the machine (the store's own install), then list again. */
function InstallLatest({
  view,
  compact = false
}: {
  view: AccountsView
  compact?: boolean
}): ReactElement | null {
  const owner = view.machine
  const override = useArtefactStore((s) => s.slideless[owner]?.override === true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A command named by CLAVE_SLIDELESS_CLI is not Clave's to replace (Software Update says the same).
  if (override) return null
  const install = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await useArtefactStore.getState().install(owner)
      await view.read()
    } catch (failure) {
      setError(refusalText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className={cn('btn-secondary', compact && 'btn-compact')}
        onClick={() => void install()}
        disabled={busy}
        data-slideless-install-latest
      >
        <ArrowDownTrayIcon className="w-3.5 h-3.5" />
        {busy ? 'Installing…' : 'Install latest'}
      </button>
      {error && (
        <span className="status-text" data-status="error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

function AccountsBody({ view }: { view: AccountsView }): ReactElement {
  const { accounts, failure, machine } = view
  // The machine's Slideless, as Software Update reads it: an override is not Clave's to update.
  useEffect(() => {
    initArtefacts()
    useArtefactStore.getState().readSlideless(machine)
  }, [machine])
  const heading = accounts?.machine
    ? `Accounts on ${accounts.machine}${accounts.cliVersion ? ` · Slideless ${accounts.cliVersion}` : ''}`
    : accounts || failure
      ? null
      : 'Reading the accounts…'
  return (
    <>
      {heading && (
        <p className="settings-row-value" data-slideless-heading>
          {heading}
        </p>
      )}
      {failure && (
        <SettingsCallout
          tone="danger"
          role="alert"
          text={failure}
          actions={
            <button type="button" className="btn-secondary" onClick={() => void view.reload()}>
              Try again
            </button>
          }
        />
      )}
      {accounts?.error && (
        <SettingsCallout
          tone="danger"
          role="alert"
          text={accounts.error}
          actions={accounts.needsUpdate ? <InstallLatest view={view} /> : undefined}
          className="slideless-listing-error"
        />
      )}
      {accounts && accounts.error === null && (
        <>
          <NewLinksSection view={view} accounts={accounts} />
          <AccountsSection view={view} accounts={accounts} />
          <AddSiteSection view={view} />
        </>
      )}
    </>
  )
}

// ── New links go to ─────────────────────────────────────────────────────────

function NewLinksSection({
  view,
  accounts
}: {
  view: AccountsView
  accounts: SlidelessAccounts
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = accounts.newLinksSite
  const known = profileAt(accounts, chosen)
  const options = [
    ...(chosen === null ? [{ value: NOT_CHOSEN, label: 'Not chosen' }] : []),
    ...accounts.profiles.map((profile) => ({
      value: normalOrigin(profile.site.origin),
      label: profileTitle(profile),
      hint: profile.site.origin
    })),
    ...(chosen !== null && !known
      ? [{ value: normalOrigin(chosen), label: `${chosen} (no longer an account here)` }]
      : [])
  ]
  const value =
    chosen === null ? NOT_CHOSEN : known ? normalOrigin(known.site.origin) : normalOrigin(chosen)
  const choose = async (origin: string): Promise<void> => {
    // « Not chosen » and a site no longer listed are what is, not choices.
    if (origin === value || !profileAt(accounts, origin)) return
    setBusy(true)
    setError(null)
    try {
      await view.run(() => api().setNewLinksSite(origin, serverIdOf(view.machine)))
    } catch (failure) {
      setError(refusalText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsSection
      title="New links go to"
      description="Where « Create link » puts a page that has no deck yet, and where a routine's first report goes. A deck already made stays on its own site."
    >
      <SettingsCard data-slideless-new-links>
        <SettingsRow
          label="Site"
          description={
            error ? (
              <span className="status-text" data-status="error" role="alert">
                {error}
              </span>
            ) : undefined
          }
        >
          <SettingsSelect
            value={value}
            options={options}
            onChange={(origin) => void choose(origin)}
            ariaLabel="New links go to"
            disabled={busy}
            testId="slideless-new-links"
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  )
}

// ── Accounts ────────────────────────────────────────────────────────────────

function AccountsSection({
  view,
  accounts
}: {
  view: AccountsView
  accounts: SlidelessAccounts
}): ReactElement {
  return (
    <SettingsSection title="Accounts">
      <SettingsCard data-slideless-accounts>
        {accounts.profiles.length === 0 ? (
          <div className="settings-row">
            <p className="settings-row-description">No site yet: add one below.</p>
          </div>
        ) : (
          accounts.profiles.map((profile) => (
            <ProfileRow
              key={profile.site.origin}
              view={view}
              accounts={accounts}
              profile={profile}
            />
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

type Form = 'sign_in' | 'paste' | 'remove'

function ProfileRow({
  view,
  accounts,
  profile
}: {
  view: AccountsView
  accounts: SlidelessAccounts
  profile: SlidelessProfile
}): ReactElement {
  const origin = normalOrigin(profile.site.origin)
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { fix } = profile.signIn
  const action = actionOf(fix)
  const status = signInStatus(profile.signIn.state)
  const signIn = signInLine(profile)
  const checked = checkLine(profile, accounts.checked)
  const behind = behindLine(profile, accounts.cliVersion)
  const checkAgain = (): void => {
    setError(null)
    void view
      .check(() => api().runSlidelessFix(origin, 'check', serverIdOf(view.machine)))
      .catch((failure: unknown) => setError(refusalText(failure)))
  }
  return (
    <div
      className="settings-card-group"
      data-slideless-profile={origin}
      data-slideless-state={profile.signIn.state}
      data-slideless-fix={fix?.kind ?? ''}
    >
      <div className="settings-row">
        <div className="min-w-0 flex-1">
          <p className="settings-row-title">
            <span data-slideless-name>{profileTitle(profile)}</span>
            {profile.default && (
              <span className="badge badge-muted ml-2 align-middle" data-slideless-default>
                default in the terminal
              </span>
            )}
          </p>
          <p className="settings-row-description" data-line="origin">
            {profile.site.origin}
          </p>
          {signIn && (
            <p className="settings-row-description" data-line="sign-in">
              {signIn}
            </p>
          )}
          {view.checking ? (
            <p className="settings-row-description" data-line="check">
              Checking…
            </p>
          ) : (
            checked && (
              <p className="settings-row-description" data-line="check">
                {checked}
              </p>
            )
          )}
          {behind && (
            <p className="settings-row-description flex items-center gap-2" data-line="behind">
              <span>{behind}</span>
              <InstallLatest view={view} compact />
            </p>
          )}
          {environmentLines(profile).map((line) => (
            <p key={line} className="settings-row-description" data-line="environment">
              {line}
            </p>
          ))}
          {error && (
            <p className="status-text" data-status="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="settings-row-controls">
          <span className="status-text" data-status={status.tone} data-slideless-status>
            {status.label}
          </span>
          {form === null && action?.kind === 'sign_in' && offersPastedKey(fix) && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setForm('paste')}
              data-slideless-action="paste_key"
            >
              Paste a key
            </button>
          )}
          {form === null && action?.kind === 'sign_in' && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setForm('sign_in')}
              data-slideless-action="sign_in"
            >
              Sign in
            </button>
          )}
          {form === null && action?.kind === 'paste_key' && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setForm('paste')}
              data-slideless-action="paste_key"
            >
              Paste a key
            </button>
          )}
          {form === null && action?.kind === 'check' && (
            <button
              type="button"
              className="btn-secondary"
              onClick={checkAgain}
              disabled={view.checking}
              data-slideless-action="check"
            >
              {view.checking ? 'Checking…' : 'Check again'}
            </button>
          )}
          {form === null && action?.kind === 'remove' && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setForm('remove')}
              data-slideless-action="remove"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {form === 'sign_in' && action?.kind === 'sign_in' && (
        <SignInForm
          view={view}
          profile={profile}
          logins={accounts.logins}
          asks={action.asks}
          onClose={() => setForm(null)}
        />
      )}
      {form === 'paste' && (
        <PasteKeyForm view={view} origin={origin} onClose={() => setForm(null)} />
      )}
      {form === 'remove' && (
        <RemoveForm view={view} origin={origin} onClose={() => setForm(null)} />
      )}
    </div>
  )
}

// ── The e-mail code sign-in ─────────────────────────────────────────────────

type SignInStep =
  | { step: 'address' }
  | { step: 'sending' }
  | { step: 'code'; id: string; email: string | null; error?: string }
  | { step: 'answering'; id: string; email: string | null }
  | { step: 'failed'; message: string }

/**
 * A site's sign-in with an e-mail code, under its row: the account's address
 * (and the hub a `pick_hub` fix asks for), Send code, then the code the
 * person received and Sign in. The code is cleared the moment it is given;
 * Cancel lets the sign-in go on the machine too, and so does closing the page
 * while one waits for its code.
 */
function SignInForm({
  view,
  profile,
  logins,
  asks,
  onClose
}: {
  view: AccountsView
  profile: SlidelessProfile
  logins: readonly SlidelessLogin[]
  asks: 'nothing' | 'hub' | 'address'
  onClose: () => void
}): ReactElement {
  const origin = normalOrigin(profile.site.origin)
  const serverId = serverIdOf(view.machine)
  const ids = useId()
  const [address, setAddress] = useState(() => prefilledAddress(profile, logins))
  const [hub, setHub] = useState(() => prefilledHub(profile, logins))
  const [code, setCode] = useState('')
  const [step, setStep] = useState<SignInStep>({ step: 'address' })
  /** The sign-in waiting on the machine, to let go of when the form goes. */
  const flight = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const id = flight.current
      flight.current = null
      if (id)
        void api()
          .cancelSlidelessSignIn(id, serverId)
          .catch(() => {})
    }
  }, [serverId])

  const settle = (answer: SlidelessSignIn, typed: string | null): void => {
    if (!mounted.current) {
      // The form went while the machine answered: its sign-in goes too.
      if (answer.phase === 'code_asked')
        void api()
          .cancelSlidelessSignIn(answer.id, serverId)
          .catch(() => {})
      return
    }
    if (answer.phase === 'code_asked') {
      flight.current = answer.id
      setStep({ step: 'code', id: answer.id, email: answer.email ?? typed })
      return
    }
    flight.current = null
    if (answer.phase === 'done') {
      onClose()
      void view.read()
    } else if (answer.phase === 'cancelled') onClose()
    else setStep({ step: 'failed', message: answer.message ?? 'Slideless did not sign in.' })
  }

  const send = async (): Promise<void> => {
    const email = address.trim()
    const chosenHub = hub.trim()
    setStep({ step: 'sending' })
    try {
      const answer = await api().startSlidelessSignIn(
        origin,
        {
          ...(email !== '' && { email }),
          ...(asks === 'hub' && chosenHub !== '' && { hub: chosenHub })
        },
        serverId
      )
      settle(answer, email || null)
    } catch (failure) {
      if (mounted.current) setStep({ step: 'failed', message: refusalText(failure) })
    }
  }

  const answer = async (id: string, email: string | null): Promise<void> => {
    const given = code
    // Given once: the field lets go of it before the call is made.
    setCode('')
    setStep({ step: 'answering', id, email })
    try {
      settle(await api().answerSlidelessSignIn(id, given, serverId), email)
    } catch (failure) {
      // Refused before it reached the command (its length): the sign-in still waits for a code.
      if (mounted.current) setStep({ step: 'code', id, email, error: refusalText(failure) })
    }
  }

  const cancel = (): void => {
    const id = flight.current
    flight.current = null
    if (id)
      void api()
        .cancelSlidelessSignIn(id, serverId)
        .catch(() => {})
    onClose()
  }

  const cancelButton = (
    <button type="button" className="btn-secondary" onClick={cancel} data-slideless-signin-cancel>
      Cancel
    </button>
  )

  if (step.step === 'code' || step.step === 'answering') {
    const busy = step.step === 'answering'
    const submit = (): void => {
      if (!busy && code.trim() !== '') void answer(step.id, step.email)
    }
    return (
      <SettingsCallout
        inset
        role="group"
        text={step.email ? `A code was sent to ${step.email}.` : 'A code was sent.'}
        actions={
          <>
            {cancelButton}
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={busy || code.trim() === ''}
              data-slideless-signin-submit
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        }
        className="slideless-sign-in"
      >
        <div className="mt-3 max-w-xs">
          <label className="field-label" htmlFor={`${ids}-code`}>
            Code
          </label>
          <input
            id={`${ids}-code`}
            className="input-compact"
            autoComplete="one-time-code"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
            disabled={busy}
            data-slideless-signin-code
          />
          {step.step === 'code' && step.error && (
            <p className="status-text mt-1.5" data-status="error" role="alert">
              {step.error}
            </p>
          )}
        </div>
      </SettingsCallout>
    )
  }

  if (step.step === 'failed')
    return (
      <SettingsCallout
        inset
        tone="danger"
        role="alert"
        actions={
          <>
            {cancelButton}
            <button
              type="button"
              className="btn-primary"
              onClick={() => setStep({ step: 'address' })}
              data-slideless-signin-retry
            >
              Try again
            </button>
          </>
        }
        className="slideless-sign-in"
      >
        <p className="status-text" data-status="error" data-slideless-signin-failure>
          {step.message}
        </p>
      </SettingsCallout>
    )

  const sending = step.step === 'sending'
  const ready =
    !sending &&
    (asks !== 'hub' || hub.trim() !== '') &&
    (asks !== 'address' || address.trim() !== '')
  return (
    <SettingsCallout
      inset
      role="group"
      actions={
        <>
          {cancelButton}
          <button
            type="button"
            className="btn-primary"
            onClick={() => void send()}
            disabled={!ready}
            data-slideless-signin-send
          >
            {sending ? 'Sending…' : 'Send code'}
          </button>
        </>
      }
      className="slideless-sign-in"
    >
      <div className="grid gap-3 max-w-md">
        {asks === 'hub' &&
          (logins.length > 0 ? (
            <div>
              <span className="field-label">Hub</span>
              <SettingsSelect
                value={hub}
                options={logins.map((login) => ({
                  value: login.hub,
                  label: hostOf(login.hub),
                  ...(login.email && { hint: login.email })
                }))}
                onChange={setHub}
                ariaLabel="Hub to sign in through"
                disabled={sending}
                testId="slideless-signin-hub"
              />
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor={`${ids}-hub`}>
                Hub address
              </label>
              <input
                id={`${ids}-hub`}
                className="input-compact"
                placeholder="https://…"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={hub}
                onChange={(event) => setHub(event.target.value)}
                disabled={sending}
                data-slideless-signin-hub-address
              />
            </div>
          ))}
        <div>
          <label className="field-label" htmlFor={`${ids}-address`}>
            Account address
          </label>
          <input
            id={`${ids}-address`}
            className="input-compact"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ready) void send()
            }}
            disabled={sending}
            data-slideless-signin-address
          />
        </div>
      </div>
    </SettingsCallout>
  )
}

// ── A pasted key, a removal ─────────────────────────────────────────────────

/** A key pasted for a site, given to the command on its input: the field is
 *  cleared as the key is given, whatever the machine answers. */
function PasteKeyForm({
  view,
  origin,
  onClose
}: {
  view: AccountsView
  origin: string
  onClose: () => void
}): ReactElement {
  const ids = useId()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (busy || key === '') return
    const given = key
    setKey('')
    setBusy(true)
    setError(null)
    try {
      await view.run(() => api().pasteSlidelessKey(origin, given, serverIdOf(view.machine)))
      onClose()
    } catch (failure) {
      setError(refusalText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCallout
      inset
      role="group"
      actions={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void save()}
            disabled={busy || key === ''}
            data-slideless-key-save
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
      className="slideless-paste-key"
    >
      <div className="max-w-md">
        <label className="field-label" htmlFor={`${ids}-key`}>
          Key
        </label>
        <input
          id={`${ids}-key`}
          className="input-compact"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
          }}
          data-slideless-key-input
        />
        {error && (
          <p className="status-text mt-1.5" data-status="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </SettingsCallout>
  )
}

/** The confirmation of a site's removal, under its row: the command revokes its keys on the site first. */
function RemoveForm({
  view,
  origin,
  onClose
}: {
  view: AccountsView
  origin: string
  onClose: () => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await view.run(() =>
        api().runSlidelessFix(origin, 'remove_profile', serverIdOf(view.machine))
      )
    } catch (failure) {
      setError(refusalText(failure))
      setBusy(false)
    }
  }
  return (
    <SettingsCallout
      inset
      tone="danger"
      role="alertdialog"
      text={`Forget ${origin} on this machine? Its keys are revoked on its site first.`}
      actions={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void remove()}
            disabled={busy}
            data-slideless-remove-confirm
          >
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </>
      }
    >
      {error && (
        <p className="status-text mt-1.5" data-status="error" role="alert">
          {error}
        </p>
      )}
    </SettingsCallout>
  )
}

// ── Add a site ──────────────────────────────────────────────────────────────

function AddSiteSection({ view }: { view: AccountsView }): ReactElement {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async (): Promise<void> => {
    const wanted = url.trim()
    if (busy || wanted === '') return
    setBusy(true)
    setError(null)
    try {
      await view.run(() => api().addSlidelessSite(wanted, serverIdOf(view.machine)))
      setUrl('')
    } catch (failure) {
      setError(refusalText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsSection title="Add a site">
      <SettingsCard data-slideless-add-site>
        <div className="settings-row">
          <div className="min-w-0 flex-1">
            <input
              className="input-compact"
              placeholder="https://…"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-label="Site address"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void add()
              }}
              data-slideless-add-input
            />
            {error && (
              <p
                className="status-text mt-1.5"
                data-status="error"
                role="alert"
                data-slideless-add-error
              >
                {error}
              </p>
            )}
          </div>
          <div className="settings-row-controls">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void add()}
              disabled={busy || url.trim() === ''}
              data-slideless-add
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
