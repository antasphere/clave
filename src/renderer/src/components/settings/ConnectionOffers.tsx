import { useState, type ReactElement } from 'react'
import { ClipboardDocumentIcon, KeyIcon } from '@heroicons/react/24/outline'
import { providerCompany } from '@clave/contract/settings/provider-catalogue'
import { useClaudeProfileStore } from '../../store/claude-profile-store'
import { useCodexAccountStore } from '../../store/codex-account-store'
import { useProviderConnectionsStore } from '../../store/provider-connections-store'
import { connectAnthropic, connectOpenAI } from './connection-companies'
import {
  connectLabel,
  connectedCountText,
  offerFacts,
  type CardCompany,
  type OfferFacts
} from './connection-cards'
import {
  CardFact,
  CardFacts,
  CardFold,
  CardFoot,
  CardHead,
  ConnectionCard,
  ConnectionGrid,
  HarnessList,
  ModelList,
  type CardModels
} from './ConnectionCard'
import { TokenForm } from './ClaudeAccountsSection'
import { ApiKeyForm } from './CodexAccountsSection'
import { AddForm } from './ProviderConnectionsSection'
import {
  codexAccountShown,
  reveal,
  submitCodexKey,
  useProviderConnectionsOf
} from './connection-actions'

/** The form open in one card to connect: a provider's add form, or the
 *  paste roads of the two subscriptions. */
type OpenForm = { company: CardCompany; kind: 'add' | 'token' | 'key' } | null

/**
 * Every provider that can be connected on a machine, as cards (PRDCT-4552):
 * its mark, its name, what it is, the harnesses it serves, the models it
 * offers, and its Connect, which opens the form in the card's place (the
 * form's fields and what they do as PRDCT-4426 built them). Anthropic and
 * OpenAI sign in through the browser from here on this Mac, a token or an API
 * key pasted as the second road; a server's subscriptions are signed in on
 * the server, so its page offers the providers alone. A provider already
 * connected takes another connection from its own card.
 */
export function ConnectionOffers({
  machine,
  subscriptions,
  modelsOf,
  onOpenChange
}: {
  machine: string
  /** This Mac: the two subscriptions are connected from here too. */
  subscriptions: boolean
  modelsOf: (company: CardCompany) => CardModels
  /** Whether a form is open in one of the cards. */
  onOpenChange?: (open: boolean) => void
}): ReactElement {
  // The form open, for the machine it was opened on: switching the machine
  // under it closes it (derived during render, not reset in an effect).
  const [opened, setOpened] = useState<{ machine: string; form: OpenForm }>({
    machine,
    form: null
  })
  const open = opened.machine === machine ? opened.form : null
  const providers = useProviderConnectionsOf(machine)
  const clearError = useProviderConnectionsStore((s) => s.clearError)
  const claudeCount = useClaudeProfileStore((s) => s.profiles.length - 1)
  const codexCount = useCodexAccountStore((s) => s.accounts.filter(codexAccountShown).length)
  const addTokenProfile = useClaudeProfileStore((s) => s.addTokenProfile)
  const addCodexAccount = useCodexAccountStore((s) => s.addAccount)
  const setOpen = (next: OpenForm): void => {
    setOpened({ machine, form: next })
    onOpenChange?.(next !== null)
  }

  const countOf = (company: CardCompany): number =>
    company === 'anthropic'
      ? claudeCount
      : company === 'openai'
        ? codexCount
        : providers.connections.filter((c) => c.company === company).length

  const openForm = (company: CardCompany, kind: 'add' | 'token' | 'key'): void => {
    clearError(machine)
    setOpen({ company, kind })
    reveal(`[data-provider-card="${company}"]`)
  }

  const signIn = async (company: 'anthropic' | 'openai'): Promise<void> => {
    setOpen(null)
    const id = company === 'anthropic' ? await connectAnthropic() : await connectOpenAI()
    if (id)
      reveal(
        company === 'anthropic'
          ? `[data-claude-account-row="${id}"]`
          : `[data-codex-account-row="${id}"]`
      )
  }

  const formFor = (offer: OfferFacts): ReactElement | null => {
    if (!open || open.company !== offer.company) return null
    if (offer.company === 'anthropic')
      return (
        <TokenForm
          title="Add a connection with a token"
          askName
          onSubmit={async (label, token) => (await addTokenProfile(label, token)).usage}
          onCancel={() => setOpen(null)}
        />
      )
    if (offer.company === 'openai')
      return (
        <ApiKeyForm
          title="Add a connection with an API key"
          askName
          onSubmit={async (label, apiKey) => {
            const created = await addCodexAccount(label, 'apiKey')
            if (!created) return 'Could not add the connection.'
            return submitCodexKey(created.id, apiKey)
          }}
          onCancel={() => setOpen(null)}
        />
      )
    const company = providerCompany(offer.company)
    return (
      <AddForm
        key={`${machine}:${company.id}`}
        machine={machine}
        company={company}
        taken={providers.connections.filter((c) => c.company === company.id).map((c) => c.label)}
        error={providers.error}
        onCancel={() => {
          clearError(machine)
          setOpen(null)
        }}
        onDone={() => setOpen(null)}
      />
    )
  }

  return (
    <ConnectionGrid offers data-connection-offers={machine}>
      {offerFacts({ subscriptions }).map((offer) => {
        const count = countOf(offer.company)
        const form = formFor(offer)
        return (
          <ConnectionCard
            key={offer.company}
            offer
            wide={form !== null}
            data-provider-card={offer.company}
          >
            <CardHead
              company={offer.company}
              title={<span className="connection-card-label">{offer.name}</span>}
              subtitle={<span className="connection-card-what">{offer.what}</span>}
            />
            <CardFacts>
              {count > 0 && (
                <CardFact term="Yours" data-provider-card-count={count}>
                  <span className="connection-card-count">{connectedCountText(count)}</span>
                </CardFact>
              )}
              <CardFact term="Harnesses">
                <HarnessList harnesses={offer.harnesses} />
              </CardFact>
              <CardFact term="Models">
                <ModelList models={modelsOf(offer.company)} id={`offer-${offer.company}`} />
              </CardFact>
            </CardFacts>
            <CardFold open={form !== null}>{form}</CardFold>
            {form === null && (
              <CardFoot
                start={
                  offer.company === 'anthropic' ? (
                    <button
                      type="button"
                      className="connection-card-link"
                      onClick={() => openForm('anthropic', 'token')}
                      title="Paste a token from `claude setup-token` instead of signing in here"
                      data-connect-secondary="anthropic"
                      data-claude-paste-token
                    >
                      <ClipboardDocumentIcon className="w-3.5 h-3.5" />
                      Paste a token
                    </button>
                  ) : offer.company === 'openai' ? (
                    <button
                      type="button"
                      className="connection-card-link"
                      onClick={() => openForm('openai', 'key')}
                      title="A connection billed per use: the pool's fallback"
                      data-connect-secondary="openai"
                      data-codex-api-key
                    >
                      <KeyIcon className="w-3.5 h-3.5" />
                      Use an API key
                    </button>
                  ) : undefined
                }
              >
                <button
                  type="button"
                  className="btn-secondary btn-compact"
                  onClick={() =>
                    offer.road === 'sign-in'
                      ? void signIn(offer.company as 'anthropic' | 'openai')
                      : openForm(offer.company, 'add')
                  }
                  title={
                    offer.road === 'sign-in'
                      ? `Sign in to ${offer.name} in the browser that opens`
                      : undefined
                  }
                  data-connect-company={offer.company}
                  {...(offer.company === 'anthropic' ? { 'data-claude-add-account': '' } : {})}
                  {...(offer.company === 'openai' ? { 'data-codex-add-account': '' } : {})}
                >
                  {connectLabel(count)}
                </button>
              </CardFoot>
            )}
          </ConnectionCard>
        )
      })}
    </ConnectionGrid>
  )
}
