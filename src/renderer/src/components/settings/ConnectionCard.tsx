import { useState, type ReactElement, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import * as DropdownMenuPrimitive from '@clave/ui/primitives/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'
import { HARNESS_BY_ID, type HarnessId } from '../../../../shared/harness'
import { AntigravityLogo, ClaudeLogo, CodexLogo, OpenCodeLogo, PiLogo } from '../icons/cli-logos'
import { ProviderLogo } from '../icons/provider-logos'
import {
  modelPreview,
  moreLabel,
  USAGE_SOURCE,
  removalSentence,
  type CardCompany,
  type CardState,
  type RemovalKind,
  type RowMenuEntry
} from './connection-cards'
import { SettingsCallout } from './primitives'

/**
 * The one card of Settings → Connections (PRDCT-4552): a Claude account, a
 * Codex account, a stored provider connection, and each provider that can be
 * connected, all in this shape. The provider's mark and name head it, then
 * what the card is about in a few facts (the harnesses that run on it, the
 * models it serves, its usage), then its actions; a form, a sign-in or a
 * removal's question opens inside it, in its place.
 */

/** The house's fold: every fold of the settings opens in 420 ms on this curve. */
const FOLD = { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const }

const HARNESS_LOGOS: Readonly<Record<HarnessId, (p: { className?: string }) => ReactElement>> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  antigravity: AntigravityLogo,
  pi: PiLogo,
  opencode: OpenCodeLogo
}

export function ConnectionGrid({
  children,
  offers = false,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
  /** The grid of providers to connect: narrower cards, more to a row. */
  offers?: boolean
}): ReactElement {
  return (
    <div className={cn('connection-grid', offers && 'connection-grid--offers')} {...rest}>
      {children}
    </div>
  )
}

/** The card itself. `wide` spans the grid's row while a form is open in it;
 *  `tone` is its state's, so a card that needs something is told apart. */
export function ConnectionCard({
  wide = false,
  tone,
  offer = false,
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLElement> & {
  wide?: boolean
  tone?: CardState['tone']
  offer?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <motion.article
      layout="position"
      transition={FOLD}
      className={cn('connection-card', offer && 'connection-card--offer', className)}
      data-wide={wide ? 'true' : undefined}
      data-tone={tone}
      {...(rest as object)}
    >
      {children}
    </motion.article>
  )
}

/** The provider's mark on its tile. */
export function ProviderMark({ company }: { company: CardCompany }): ReactElement {
  return (
    <span className="connection-card-mark" aria-hidden>
      <ProviderLogo company={company} />
    </span>
  )
}

/** The head: the mark, the title (the connection's label, or the provider's
 *  name on a card to connect), what it is, and the state on the right. */
export function CardHead({
  company,
  title,
  subtitle,
  aside
}: {
  company: CardCompany
  title: ReactNode
  subtitle: ReactNode
  aside?: ReactNode
}): ReactElement {
  return (
    <header className="connection-card-head">
      <ProviderMark company={company} />
      <div className="connection-card-titles">
        <div className="connection-card-title">{title}</div>
        <p className="connection-card-subtitle">{subtitle}</p>
      </div>
      {aside && <div className="connection-card-aside">{aside}</div>}
    </header>
  )
}

/** The connection's label, renamed in place: the label until Rename is
 *  pressed, then a field that commits on Enter or when it loses focus and
 *  gives up on Escape. */
export function CardLabel({
  label,
  draft,
  onDraft,
  onCommit,
  labelProps,
  inputProps
}: {
  label: string
  /** The name being typed, or null while the label is only shown. */
  draft: string | null
  onDraft: (value: string | null) => void
  onCommit: (value: string) => void
  labelProps?: Record<string, string>
  inputProps?: Record<string, string | boolean>
}): ReactElement {
  if (draft === null)
    return (
      <span className="connection-card-label" {...labelProps}>
        {label}
      </span>
    )
  const commit = (): void => {
    const next = draft.trim()
    onDraft(null)
    if (next && next !== label) onCommit(next)
  }
  return (
    <input
      className="input-compact connection-card-rename"
      value={draft}
      onChange={(e) => onDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') onDraft(null)
      }}
      aria-label="Connection name"
      autoFocus
      {...inputProps}
    />
  )
}

/** The company and what it is, as the subtitle reads them. */
export function CompanyWhat({ company, what }: { company: string; what: string }): ReactElement {
  return (
    <>
      <span>{company}</span>
      <span className="connection-card-what">{what}</span>
    </>
  )
}

/** The state in plain words, a dot in its tone before it. */
export function CardStateText({
  state,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { state: CardState }): ReactElement {
  return (
    <span className="connection-card-state" data-tone={state.tone} {...rest}>
      {state.label}
    </span>
  )
}

/** The facts under the head, one line each: a word on the left, the fact. */
export function CardFacts({ children }: { children: ReactNode }): ReactElement {
  return <dl className="connection-card-facts">{children}</dl>
}

export function CardFact({
  term,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { term: string; children: ReactNode }): ReactElement {
  return (
    <div className="connection-card-fact" {...rest}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** The harnesses that run on it, each by its logo and its name. */
export function HarnessList({ harnesses }: { harnesses: readonly HarnessId[] }): ReactElement {
  if (harnesses.length === 0) return <span className="connection-card-quiet">None yet</span>
  return (
    <span className="connection-card-harnesses" data-connection-harnesses={harnesses.join(' ')}>
      {harnesses.map((id) => {
        const Logo = HARNESS_LOGOS[id]
        return (
          <span key={id} className="connection-card-harness">
            <Logo />
            {HARNESS_BY_ID[id].name}
          </span>
        )
      })}
    </span>
  )
}

/** What a card knows of its models: the names, still reading, or a sentence
 *  saying why there is no list. */
export type CardModels = { names: readonly string[] } | 'loading' | { note: string }

/** The models it serves: the first few by name, the rest behind one control
 *  that unfolds them in place. */
export function ModelList({ models, id }: { models: CardModels; id: string }): ReactElement {
  const [open, setOpen] = useState(false)
  if (models === 'loading') return <span className="connection-card-quiet">Reading…</span>
  if ('note' in models) return <span className="connection-card-quiet">{models.note}</span>
  if (models.names.length === 0)
    return <span className="connection-card-quiet">None listed yet</span>
  const { first, rest } = modelPreview(models.names)
  return (
    <div className="connection-card-models" data-connection-models={id}>
      <ul className="connection-card-model-list">
        {first.map((name) => (
          <li key={name} className="connection-card-model">
            {name}
          </li>
        ))}
        {rest.length > 0 && !open && (
          <li>
            <button
              type="button"
              className="connection-card-more"
              aria-expanded={false}
              onClick={() => setOpen(true)}
              data-connection-models-toggle={id}
            >
              {moreLabel(rest.length, false)}
            </button>
          </li>
        )}
      </ul>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="rest"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={FOLD}
            style={{ overflow: 'hidden' }}
            data-connection-models-rest={id}
          >
            <ul className="connection-card-model-list connection-card-model-list--rest">
              {rest.map((name) => (
                <li key={name} className="connection-card-model">
                  {name}
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="connection-card-more"
                  aria-expanded
                  onClick={() => setOpen(false)}
                  data-connection-models-toggle={id}
                >
                  {moreLabel(rest.length, true)}
                </button>
              </li>
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** The usage of a card. A Claude or a Codex account has one line, its
 *  provider's limits. A stored connection (`own` given) has two, never
 *  mixed and each named: the provider's own line, then what its own Pi and
 *  OpenCode tabs used today (PRDCT-4551), which fills in once read. */
export function UsageLine({
  text,
  id,
  own,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & {
  text: string | null
  id: string
  /** The connection's own usage today; null while its first read runs. */
  own?: string | null
}): ReactElement {
  const provider = (
    <span className={text ? undefined : 'connection-card-quiet'} {...rest}>
      {text ?? 'Not read yet'}
    </span>
  )
  if (own === undefined) return <span className="connection-card-usage">{provider}</span>
  return (
    <span className="connection-card-usage connection-card-usage--two">
      <span className="connection-card-usage-line">
        <span className="connection-card-usage-source">{USAGE_SOURCE.provider}</span>
        {provider}
      </span>
      <span
        className="connection-card-usage-line"
        data-connection-own-usage={id}
        data-connection-own-usage-state={own === null ? 'reading' : 'read'}
        hidden={own === null}
      >
        <span className="connection-card-usage-source">{USAGE_SOURCE.tabs}</span>
        <span className="connection-card-own-usage">{own}</span>
      </span>
    </span>
  )
}

/** Whatever opens inside the card (a form, a sign-in, a question), folding
 *  open in the house's timing, edge to edge as a row of a settings card. */
export function CardFold({ open, children }: { open: boolean; children: ReactNode }): ReactElement {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="fold"
          className="connection-card-fold"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={FOLD}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** The foot: what the card is used for on the left, its actions on the right. */
export function CardFoot({
  start,
  hidden = false,
  children
}: {
  start?: ReactNode
  /** A form or a question is open in the card: its own buttons stand in. */
  hidden?: boolean
  children?: ReactNode
}): ReactElement | null {
  if (hidden) return null
  return (
    <footer className="connection-card-foot">
      <div className="connection-card-foot-start">{start}</div>
      {children && <div className="connection-card-actions">{children}</div>}
    </footer>
  )
}

// ── A connected provider: one card, its connections as rows ────────────────

/** A provider with at least one connection, as one card across the page
 *  (PRDCT-4552): its head says once what every connection of it shares (the
 *  mark, the name, what it is, the harnesses, the models), its connections
 *  are rows under it in the pool's order, and its foot connects another,
 *  the form opening inside the card. */
export function ProviderCard({
  company,
  name,
  what,
  harnesses,
  models,
  modelsId,
  rows,
  foot,
  form,
  ...rest
}: React.HTMLAttributes<HTMLElement> & {
  company: CardCompany
  name: string
  what: string
  harnesses: readonly HarnessId[]
  models: CardModels
  modelsId: string
  rows: ReactNode
  /** "Connect another" and its second road; absent where nothing is connected
   *  from here (a server's own accounts). */
  foot?: ReactNode
  /** The add form, open inside the card. */
  form?: ReactNode
}): ReactElement {
  return (
    <motion.article
      layout="position"
      transition={FOLD}
      className="connection-card connection-card--provider"
      {...(rest as object)}
    >
      <header className="connection-card-head">
        <ProviderMark company={company} />
        <div className="connection-card-titles">
          <div className="connection-card-title">
            <span className="connection-card-label">{name}</span>
          </div>
          <p className="connection-card-subtitle">
            <span className="connection-card-what">{what}</span>
          </p>
        </div>
      </header>
      <CardFacts>
        <CardFact term="Harnesses">
          <HarnessList harnesses={harnesses} />
        </CardFact>
        <CardFact term="Models">
          <ModelList models={models} id={modelsId} />
        </CardFact>
      </CardFacts>
      <div className="connection-rows">{rows}</div>
      <CardFold open={!!form}>{form}</CardFold>
      {foot && !form && <footer className="connection-card-foot">{foot}</footer>}
    </motion.article>
  )
}

/** The row's one menu: every action a row has but its one needed button,
 *  each entry in words. The destructive one stands last, apart. */
export function RowMenu({
  id,
  label,
  entries
}: {
  id: string
  label: string
  entries: readonly RowMenuEntry[]
}): ReactElement | null {
  const [keepFocus, setKeepFocus] = useState(false)
  if (entries.length === 0) return null
  const plain = entries.filter((e) => !e.danger)
  const danger = entries.filter((e) => e.danger)
  const item = (entry: RowMenuEntry): ReactElement => (
    <DropdownMenuPrimitive.Item
      key={entry.label}
      className={cn('menu-item', entry.danger && 'menu-item--danger')}
      onSelect={() => {
        setKeepFocus(!!entry.opensField)
        entry.onSelect()
      }}
      {...entry.attrs}
    >
      {entry.label}
    </DropdownMenuPrimitive.Item>
  )
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className="btn-secondary btn-compact connection-row-menu"
          aria-label={`Manage ${label}`}
          data-connection-menu={id}
        >
          Manage
          <ChevronDownIcon className="w-3 h-3" aria-hidden />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="menu-surface menu-pop z-50 p-1"
          data-connection-menu-entries={id}
          onCloseAutoFocus={(e) => {
            // A field the entry opened keeps the focus it took.
            if (keepFocus) e.preventDefault()
            setKeepFocus(false)
          }}
        >
          {plain.map(item)}
          {danger.length > 0 && plain.length > 0 && (
            <DropdownMenuPrimitive.Separator className="menu-sep" />
          )}
          {danger.map(item)}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

/** One connection, a row of its provider's card: the choice of where new
 *  sessions start (Claude and Codex), the label and its badges, the state in
 *  a word, the one button it needs and its menu; under it, its usage and
 *  its sign-in; then whatever opens on it (a form, a sign-in, the removal's
 *  question). */
export function ConnectionRow({
  pick,
  heading,
  state,
  stateAttrs,
  fix,
  menu,
  lines,
  fold,
  ...rest
}: Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> & {
  pick?: ReactNode
  heading: ReactNode
  state: CardState
  stateAttrs?: Record<string, string>
  fix?: ReactNode
  menu?: ReactNode
  lines: ReactNode
  fold?: ReactNode
}): ReactElement {
  return (
    <div className="connection-row" data-tone={state.tone} {...rest}>
      <div className="connection-row-main">
        {pick && <span className="connection-row-pick">{pick}</span>}
        <div className="connection-row-body">
          <div className="connection-row-head">
            <div className="connection-row-title">{heading}</div>
            <CardStateText state={state} {...stateAttrs} />
            {(fix || menu) && (
              <div className="connection-row-actions">
                {fix}
                {menu}
              </div>
            )}
          </div>
          <div className="connection-row-lines">{lines}</div>
        </div>
      </div>
      {fold}
    </div>
  )
}

/** A quiet line under a row's usage: its sign-in, where it lives. */
export function RowNote({ children }: { children: ReactNode }): ReactElement {
  return <span className="connection-row-note">{children}</span>
}

/** The question a removal asks before anything goes (PRDCT-4552): what is
 *  deleted, and what keeps running. */
export function RemoveConfirm({
  kind,
  label,
  machine,
  id,
  onCancel,
  onRemove
}: {
  kind: RemovalKind
  label: string
  machine: string
  id: string
  onCancel: () => void
  onRemove: () => void
}): ReactElement {
  const { question, consequence } = removalSentence(kind, label, machine)
  return (
    <div data-connection-remove-question={id}>
      <SettingsCallout
        inset
        tone="danger"
        role="alertdialog"
        title={question}
        text={consequence}
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={onCancel}
              autoFocus
              data-connection-remove-cancel={id}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onRemove}
              data-connection-remove-confirm={id}
            >
              Remove
            </button>
          </>
        }
      />
    </div>
  )
}
