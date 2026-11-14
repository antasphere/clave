import { useState, type ReactElement } from 'react'
import { KeyIcon } from '@heroicons/react/24/outline'
import { providerCompany } from '@clave/contract/settings/provider-catalogue'
import { useCodexAccountStore } from '../../store/codex-account-store'
import { useProviderConnectionsStore } from '../../store/provider-connections-store'
import { connectOpenAI } from './connection-companies'
import { connectLabel, offerFacts, type CardCompany, type OfferFacts } from './connection-cards'
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
import { NewCodexKeyForm } from './CodexAccountsSection'
import { AddForm } from './ProviderConnectionsSection'
import { codexAccountShown, reveal, useProviderConnectionsOf } from './connection-actions'

/** The form open in one card to connect: a provider's add form, or OpenAI's
 *  API key. */
type OpenForm = { company: CardCompany; kind: 'add' | 'key' } | null

/**
 * The providers that can be connected on a machine and are not yet
 * (PRDCT-4552), as cards: the mark, the name, what it is, the harnesses it
 * serves, the models it offers, and its Connect, which opens the form in the
 * card's place (the form's fields and what they do as PRDCT-4426 built them).
 * A provider already connected is not repeated here: its own card above
 * connects another. Anthropic is always above on this Mac (the machine's own
 * login is its first connection); OpenAI signs in through the browser from
 * here, an API key as its second road; a server's subscriptions are signed in
 * on the server, so its page offers the providers alone.
 */
export function ConnectionOffers({
  machine,
  subscriptions,
  modelsOf,
  onOpenChange
}: {
  machine: string
  /** This Mac: OpenAI is connected from here too. */
  subscriptions: boolean
  modelsOf: (company: CardCompany) => CardModels
  /** Whether a form is open in one of the cards. */
  onOpenChange?: (open: boolean) => void
}): ReactElement | null {
  // The form open, for the machine it was opened on: switching the machine
  // under it closes it (derived during render, not reset in an effect).
  const [opened, setOpened] = useState<{ machine: string; form: OpenForm }>({
    machine,
    form: null
  })
  const open = opened.machine === machine ? opened.form : null
  const providers = useProviderConnectionsOf(machine)
  const clearError = useProviderConnectionsStore((s) => s.clearError)
  const codexConnected = useCodexAccountStore((s) => s.accounts.some(codexAccountShown))
  const setOpen = (next: OpenForm): void => {
    setOpened({ machine, form: next })
    onOpenChange?.(next !== null)
  }

  const connected = (company: CardCompany): boolean =>
    company === 'anthropic'
      ? true
      : company === 'openai'
        ? codexConnected
        : providers.connections.some((c) => c.company === company)

  const openForm = (company: CardCompany, kind: 'add' | 'key'): void => {
    clearError(machine)
    setOpen({ company, kind })
    reveal(`[data-provider-card="${company}"]`)
  }

  const formFor = (offer: OfferFacts): ReactElement | null => {
    if (!open || open.company !== offer.company) return null
    if (offer.company === 'openai') return <NewCodexKeyForm onClose={() => setOpen(null)} />
    const company = providerCompany(offer.company as Parameters<typeof providerCompany>[0])
    return (
      <AddForm
        key={`${machine}:${company.id}`}
        machine={machine}
        company={company}
        taken={[]}
        error={providers.error}
        onCancel={() => {
          clearError(machine)
          setOpen(null)
        }}
        onDone={() => setOpen(null)}
      />
    )
  }

  const offers = offerFacts({ subscriptions }).filter((offer) => !connected(offer.company))
  if (offers.length === 0) return null
  return (
    <ConnectionGrid offers data-connection-offers={machine}>
      {offers.map((offer) => {
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
                  offer.company === 'openai' ? (
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
                    offer.company === 'openai'
                      ? void connectOpenAI().then((id) => {
                          setOpen(null)
                          if (id) reveal(`[data-codex-account-row="${id}"]`)
                        })
                      : openForm(offer.company, 'add')
                  }
                  title={
                    offer.road === 'sign-in'
                      ? `Sign in to ${offer.name} in the browser that opens`
                      : undefined
                  }
                  data-connect-company={offer.company}
                  {...(offer.company === 'openai' ? { 'data-codex-add-account': '' } : {})}
                >
                  {connectLabel(0)}
                </button>
              </CardFoot>
            )}
          </ConnectionCard>
        )
      })}
    </ConnectionGrid>
  )
}
