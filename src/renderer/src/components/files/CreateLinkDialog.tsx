import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type {
  Artefact,
  ArtefactDeck,
  ArtefactShareLink,
  ArtefactShareRequest,
  SlidelessAccounts
} from '@clave/contract/artefacts/model'
import { useSessionStore } from '../../store/session-store'
import { useSettingsMachineStore } from '../../store/settings-machine-store'
import {
  DEFAULT_LINK_FIELDS,
  dayAfter,
  defaultSite,
  firstSiteNotice,
  linkFieldsProblem,
  linkSettings,
  normalOrigin,
  profileAt,
  profileTitle,
  refusalText,
  shortDate,
  siteLabel,
  type LinkFields
} from '../../lib/slideless-accounts'
import { SettingsSelect, Toggle } from '../settings/primitives'

/**
 * « Create link » on an artefact (PRDCT-4266): the page pushed to its deck on
 * a Slideless site by the server its session runs on, and a link made to it
 * with the settings chosen here. A deck already made stays on its own site,
 * so the site is chosen only for an artefact that has none yet (preselected
 * with the machine's « New links go to »), and again when the deck is no
 * longer on its site (« Make a new deck »). Once a link is made, the primary
 * says it makes another (« Create another link »): each press is a new live
 * link. Under the form, the links Clave made to the deck, each to copy or
 * revoke.
 *
 * On the app's own modal, as `AddLocationDialog` is: the `.modal-card`
 * surface, the title block, the system's fields and switches, and the
 * `.btn-dialog` footer pair. A password lives in the field alone, cleared
 * once a link is made with it.
 */

const api = (): Window['electronAPI']['artefacts'] => window.electronAPI.artefacts

type SwitchKey = 'annotator' | 'forms' | 'download' | 'bar' | 'pdf' | 'pinVersion'

/** The switches a link carries, in the order the dialog shows them. */
const SWITCHES: { key: SwitchKey; label: string }[] = [
  { key: 'annotator', label: 'Annotations' },
  { key: 'forms', label: 'Forms' },
  { key: 'download', label: 'Downloads' },
  { key: 'bar', label: 'The bar over the deck' },
  { key: 'pdf', label: 'PDF export' },
  { key: 'pinVersion', label: 'Stays on this version' }
]

/** A deck the site no longer has, as the dialog names it. */
interface GoneDeck {
  deckId: string
  site: string
}

/** The deck a view names, recorded by Clave or by the folder's own link file. */
const deckOf = (deck: ArtefactDeck): GoneDeck | null =>
  deck.deckId && deck.site
    ? { deckId: deck.deckId, site: deck.site }
    : deck.linkedFolder
      ? { deckId: deck.linkedFolder.deckId, site: deck.linkedFolder.site }
      : null

export function CreateLinkDialog({
  sessionId,
  artefact,
  owner,
  machineName,
  onClose
}: {
  sessionId: string
  artefact: Artefact
  /** The machine the session runs on: `'local'`, or a server's id. */
  owner: string
  /** The server's name, for a server's session; null for this Mac. */
  machineName: string | null
  onClose: () => void
}): ReactElement {
  const ids = useId()
  const firstField = useRef<HTMLInputElement>(null)
  const [deck, setDeck] = useState<ArtefactDeck | null>(null)
  const [accounts, setAccounts] = useState<SlidelessAccounts | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  /** The site picked in the select; empty until the person picks one. */
  const [picked, setPicked] = useState('')
  const [fields, setFields] = useState<LinkFields>(DEFAULT_LINK_FIELDS)
  const [pushing, setPushing] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [made, setMade] = useState<ArtefactShareLink | null>(null)
  const [gone, setGone] = useState<GoneDeck | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // What the deck is, and the machine's sites, read as the dialog opens.
  useEffect(() => {
    let open = true
    api()
      .artefactDeck(sessionId, artefact.target)
      .then(
        (view) => open && setDeck(view),
        (error: unknown) => open && setLoadError(refusalText(error))
      )
    api()
      .slidelessAccounts(owner === LOCAL_SERVER_ID ? undefined : owner)
      .then(
        (listing) => {
          if (!open) return
          setAccounts(listing)
          if (listing.error) setAccountsError(listing.error)
        },
        (error: unknown) => open && setAccountsError(refusalText(error))
      )
    return () => {
      open = false
    }
  }, [sessionId, artefact.target, owner])

  // The first field takes the keys once the menu that opened the dialog has let go of them.
  useEffect(() => {
    const timer = setTimeout(() => firstField.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  // The site is offered for an artefact with no deck yet, and again for a deck gone from its site.
  const choosing = gone !== null || (deck !== null && deck.site === null && !deck.linkedFolder)
  const preferred = gone && profileAt(accounts, gone.site) ? normalOrigin(gone.site) : ''
  const site = picked || preferred || defaultSite(accounts)
  // The listing's first site, offered only because « New links go to » is not chosen: said so.
  const firstSite = firstSiteNotice(accounts, picked || preferred)
  const siteProfile = profileAt(accounts, site)
  const problem = linkFieldsProblem(fields)
  const set = <K extends keyof LinkFields>(key: K, value: LinkFields[K]): void =>
    setFields((current) => ({ ...current, [key]: value }))

  const create = async (): Promise<void> => {
    if (problem) {
      setRefusal(problem)
      return
    }
    const newDeck = gone !== null
    const request: ArtefactShareRequest = {
      ...(choosing && site !== '' && { site }),
      ...(newDeck && { newDeck: true }),
      link: linkSettings(fields)
    }
    setPushing(true)
    setRefusal(null)
    setMade(null)
    try {
      const result = await api().shareArtefact(sessionId, artefact.target, request)
      setDeck(result.deck)
      if (result._tag === 'shared') {
        setMade(result.link)
        setGone(null)
        setPicked('')
        // The password made its link: it leaves the field.
        setFields((current) => ({ ...current, password: '' }))
      } else {
        const known = deckOf(result.deck)
        setGone(known ?? { deckId: '', site: site })
        setPicked('')
      }
    } catch (error) {
      setRefusal(refusalText(error))
    } finally {
      setPushing(false)
    }
  }

  const revoke = async (tokenId: string): Promise<void> => {
    setRevoking(tokenId)
    setRevokeError(null)
    try {
      const view = await api().revokeArtefactLink(sessionId, artefact.target, tokenId)
      setDeck(view)
      setConfirming(null)
      if (made?.tokenId === tokenId) setMade(null)
    } catch (error) {
      setRevokeError(refusalText(error))
    } finally {
      setRevoking(null)
    }
  }

  const copy = (url: string): void => {
    void navigator.clipboard.writeText(url).then(
      () => setCopied(url),
      () => setCopied(null)
    )
  }

  const openSlidelessSettings = (): void => {
    useSettingsMachineStore.getState().setMachine(owner)
    useSessionStore.getState().openSettings('slideless')
    onClose()
  }

  const where = (origin: string, version: number | null): string =>
    `On ${siteLabel(accounts, origin)} (${origin})${version !== null ? ` · version ${version}` : ''}`

  const siteOptions = (accounts?.profiles ?? []).map((profile) => ({
    value: normalOrigin(profile.site.origin),
    label: profileTitle(profile),
    hint: profile.site.origin
  }))

  const siteChoice = (
    <div>
      <span className="field-label">Site</span>
      <SettingsSelect
        value={site}
        options={siteOptions}
        onChange={setPicked}
        ariaLabel="Site"
        placeholder="No site"
        disabled={pushing}
        className="w-full"
        testId="create-link-site"
      />
      {firstSite && (
        <p className="mt-1.5 text-xs text-text-tertiary" data-create-link-first-site>
          {firstSite}
        </p>
      )}
      {siteProfile?.signIn.state === 'needs_login' && (
        <p className="mt-1.5 flex flex-wrap items-center gap-2" data-create-link-sign-in>
          <span className="status-text" data-status="connecting">
            Sign in to this site in Settings › Slideless first.
          </span>
          <button
            type="button"
            className="btn-secondary btn-compact"
            onClick={openSlidelessSettings}
          >
            Open Settings
          </button>
        </p>
      )}
      {accountsError && (
        <p className="status-text mt-1.5 block" data-status="error" role="alert">
          {accountsError}
        </p>
      )}
    </div>
  )

  const links = deck ? [...deck.links].reverse() : []

  return createPortal(
    <div
      className="modal-scrim scrim-mount z-50 flex items-center justify-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal-card modal-pop w-full max-w-md mx-4 flex flex-col max-h-[85vh]"
        data-state="open"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        data-testid="create-link-dialog"
        onKeyDown={(event) => {
          // An open select's menu is portaled out of the card: its Escape closes the menu only.
          if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return
          event.stopPropagation()
          onClose()
        }}
      >
        <div className="px-4 pt-4 pb-3 flex-shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 id={`${ids}-title`} className="text-control font-semibold text-text-primary">
                Create link
              </h3>
              <p className="mt-1 text-xs text-text-secondary truncate" data-create-link-subtitle>
                {machineName ? `${artefact.title} on ${machineName}` : artefact.title}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="btn-icon btn-icon-sm"
              title="Close"
              aria-label="Close"
            >
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="px-4 pb-4 space-y-3 overflow-y-auto overscroll-contain">
          {loadError ? (
            <p className="status-text block" data-status="error" role="alert">
              {loadError}
            </p>
          ) : !deck ? (
            <p className="text-xs text-text-tertiary">Reading the deck…</p>
          ) : gone ? (
            <>
              <p
                className="status-text block"
                data-status="error"
                role="alert"
                data-create-link-gone
              >
                {`The deck ${gone.deckId} is no longer on ${siteLabel(accounts, gone.site)}.`}
              </p>
              {siteChoice}
            </>
          ) : deck.site ? (
            <p className="text-control text-text-secondary" data-create-link-where>
              {where(deck.site, deck.version)}
            </p>
          ) : deck.linkedFolder ? (
            <p className="text-control text-text-secondary" data-create-link-where>
              {`This folder is already a deck on ${siteLabel(accounts, deck.linkedFolder.site)}: the link goes there.`}
            </p>
          ) : (
            siteChoice
          )}

          <div>
            <label className="field-label" htmlFor={`${ids}-name`}>
              Link for
            </label>
            <input
              ref={firstField}
              id={`${ids}-name`}
              className="input-compact"
              placeholder="Who is it for?"
              autoComplete="off"
              value={fields.name}
              onChange={(event) => set('name', event.target.value)}
              data-create-link-name
            />
          </div>

          <div>
            <span className="field-label">Expires</span>
            <div className="flex items-center gap-2">
              <div className="segmented" aria-label="Expires">
                <button
                  type="button"
                  className="segmented-item"
                  data-active={fields.expires === null ? 'true' : undefined}
                  onClick={() => set('expires', null)}
                >
                  Never
                </button>
                <button
                  type="button"
                  className="segmented-item"
                  data-active={fields.expires !== null ? 'true' : undefined}
                  onClick={() => set('expires', fields.expires ?? dayAfter(new Date(), 7))}
                  data-create-link-expires-on
                >
                  On a date
                </button>
              </div>
              {fields.expires !== null && (
                <input
                  type="date"
                  className="input-compact w-auto tabular-nums"
                  aria-label="Expires on"
                  min={dayAfter(new Date(), 0)}
                  value={fields.expires}
                  onChange={(event) => set('expires', event.target.value || null)}
                  data-create-link-expires
                />
              )}
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor={`${ids}-password`}>
              Password
            </label>
            <input
              id={`${ids}-password`}
              className="input-compact"
              type="password"
              autoComplete="new-password"
              placeholder="None"
              value={fields.password}
              aria-invalid={problem ? 'true' : undefined}
              onChange={(event) => set('password', event.target.value)}
              data-create-link-password
            />
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            {SWITCHES.map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className="text-control text-text-secondary">{label}</span>
                <Toggle
                  checked={fields[key]}
                  onChange={(value) => set(key, value)}
                  ariaLabel={label}
                />
              </div>
            ))}
          </div>

          {made && deck && (
            <div data-create-link-made>
              <label className="field-label" htmlFor={`${ids}-url`}>
                Link
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id={`${ids}-url`}
                  className="input-compact"
                  readOnly
                  value={made.url}
                  onFocus={(event) => event.currentTarget.select()}
                  data-create-link-url
                />
                <button type="button" className="btn-secondary" onClick={() => copy(made.url)}>
                  {copied === made.url ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void window.electronAPI.openExternal(made.url)}
                >
                  Open
                </button>
              </div>
            </div>
          )}

          {pushing && (
            <p className="status-text block" role="status" data-create-link-pushing>
              Pushing the page…
            </p>
          )}
          {!pushing && (refusal ?? problem) && (
            <p
              className="status-text block"
              data-status="error"
              role="alert"
              data-create-link-refusal
            >
              {refusal ?? problem}
            </p>
          )}

          {links.length > 0 && (
            <div data-create-link-links>
              <span className="field-label">Links made from Clave</span>
              <ul className="space-y-2">
                {links.map((link) => (
                  <li
                    key={link.tokenId}
                    className="flex items-center gap-2"
                    data-create-link-token={link.tokenId}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-control text-text-primary truncate">{link.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
                        <span>{shortDate(link.createdAt)}</span>
                        {link.expiresAt && <span>Expires {shortDate(link.expiresAt)}</span>}
                        {link.hasPassword && <span className="badge badge-muted">Password</span>}
                        {link.pinnedVersion !== null && (
                          <span className="badge badge-muted">Version {link.pinnedVersion}</span>
                        )}
                      </p>
                    </div>
                    {confirming === link.tokenId ? (
                      <>
                        <span className="text-xs text-text-secondary">Revoke it?</span>
                        <button
                          type="button"
                          className="btn-secondary btn-compact"
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn-primary btn-compact"
                          onClick={() => void revoke(link.tokenId)}
                          disabled={revoking !== null}
                          data-create-link-revoke-confirm
                        >
                          {revoking === link.tokenId ? 'Revoking…' : 'Revoke'}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn-secondary btn-compact"
                          onClick={() => copy(link.url)}
                        >
                          {copied === link.url ? 'Copied' : 'Copy'}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary btn-compact"
                          onClick={() => setConfirming(link.tokenId)}
                          data-create-link-revoke
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {revokeError && (
                <p className="status-text mt-1.5 block" data-status="error" role="alert">
                  {revokeError}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border-subtle flex flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="btn-dialog text-text-secondary hover:text-text-primary border-r border-border-subtle"
            data-create-link-cancel
          >
            {made ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={!deck || pushing || !!problem}
            className="btn-dialog text-action disabled:opacity-40 disabled:cursor-not-allowed"
            data-create-link-submit
          >
            {gone ? 'Make a new deck' : made ? 'Create another link' : 'Create link'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
