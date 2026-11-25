import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ChevronRightIcon, PlusIcon } from '@heroicons/react/24/outline'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  NO_STYLE,
  WRITING_STYLE_LIMITS,
  WRITING_STYLES_NEED_UPDATE,
  type WritingStyle,
  type WritingStyleDraft
} from '../../../../shared/writing-styles'
import { STATUS_CARD_RULE } from '../../../../shared/status-card'
import { HARNESSES } from '../../../../shared/harness'
import {
  EMPTY_DRAFT,
  EMPTY_MACHINE_STYLES,
  deleteWritingStyle,
  draftOf,
  duplicateDraft,
  importClaudeOutputStyle,
  loadWritingStyles,
  saveWritingStyle,
  setDefaultWritingStyle,
  styleSupportLine,
  useWritingStylesStore,
  writingStylesDescription
} from '../../store/writing-styles-store'
import {
  SettingsCallout,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  Toggle
} from './primitives'

/**
 * The Writing styles page of the Agents group (PRDCT-5166): how agents write
 * to the person, as named instructions the machine the picker names keeps,
 * and the one its new tabs start with. The same body serves this Mac and a
 * server (`ServerPages.tsx` wraps it with the server's notice), as the
 * Helpers page does.
 */

/** Past this share of the limit, the editor counts the instructions' characters. */
const COUNT_FROM = 0.8

/** The fold's motion, every fold of the house's (420 ms). */
const FOLD = { duration: 0.42, ease: [0.22, 1, 0.36, 1] as const }

/** What the editor is open on: a draft, read-only for a built-in style. */
export interface EditorState {
  draft: WritingStyleDraft
  readOnly: boolean
}

/** The editor of one style. A built-in opens read-only, with Duplicate in
 *  place of Save; a refusal's sentence is shown beside Save. */
export function WritingStyleEditor({
  initial,
  readOnly,
  onSave,
  onDuplicate,
  onCancel
}: {
  initial: WritingStyleDraft
  readOnly: boolean
  /** The refusal's sentence, or null when the save landed. */
  onSave: (draft: WritingStyleDraft) => Promise<string | null>
  onDuplicate: (draft: WritingStyleDraft) => void
  onCancel: () => void
}): ReactElement {
  const [draft, setDraft] = useState(initial)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [ruleOpen, setRuleOpen] = useState(false)
  const change = (patch: Partial<WritingStyleDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setRefusal(null)
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    const answer = await onSave(draft)
    setSaving(false)
    setRefusal(answer)
  }
  const counted = draft.text.length >= WRITING_STYLE_LIMITS.text * COUNT_FROM
  return (
    <SettingsCard data-writing-style-editor={draft.id ?? 'new'}>
      <SettingsRow label="Name">
        <input
          className="input-compact w-72"
          value={draft.name}
          onChange={(event) => change({ name: event.target.value })}
          maxLength={WRITING_STYLE_LIMITS.name}
          readOnly={readOnly}
          aria-label="Name"
          data-testid="writing-style-name"
        />
      </SettingsRow>
      <SettingsRow
        label="When to use it"
        description="Agents read this when they choose a style for a tab they open."
      >
        <input
          className="input-compact w-72"
          value={draft.description}
          onChange={(event) => change({ description: event.target.value })}
          maxLength={WRITING_STYLE_LIMITS.description}
          readOnly={readOnly}
          aria-label="When to use it"
          data-testid="writing-style-description"
        />
      </SettingsRow>
      <div className="settings-card-inset">
        <label className="field-label" htmlFor="writing-style-text">
          Instructions
        </label>
        <textarea
          id="writing-style-text"
          className="textarea-field"
          rows={12}
          value={draft.text}
          onChange={(event) => change({ text: event.target.value })}
          readOnly={readOnly}
          spellCheck={!readOnly}
          data-testid="writing-style-text"
        />
        {counted && (
          <p className="settings-row-description" data-writing-style-count>
            {draft.text.length} of {WRITING_STYLE_LIMITS.text} characters
          </p>
        )}
      </div>
      <div className="settings-row">
        <div className="min-w-0">
          <p className="settings-row-title">End each answer with a status card</p>
          <p className="settings-row-description">
            The agent ends its turn with what it is doing, where it stands, what is to decide and
            what you must do next. Clave draws it as a card under the answer.
          </p>
        </div>
        <div className="settings-row-controls" data-testid="writing-style-card">
          <Toggle
            checked={draft.statusCard}
            onChange={(statusCard) => change({ statusCard })}
            disabled={readOnly}
            ariaLabel="End each answer with a status card"
          />
        </div>
      </div>
      {draft.statusCard && (
        <>
          <button
            className="settings-row-action"
            onClick={() => setRuleOpen((open) => !open)}
            aria-expanded={ruleOpen}
            data-writing-style-rule-fold
          >
            <ChevronRightIcon
              className={`w-4 h-4 transition-transform ${ruleOpen ? 'rotate-90' : ''}`}
              aria-hidden
            />
            What Clave adds to the instructions
          </button>
          <AnimatePresence initial={false}>
            {ruleOpen && (
              <motion.div
                key="rule"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={FOLD}
                style={{ overflow: 'hidden' }}
              >
                <div className="settings-card-inset">
                  <textarea
                    className="textarea-field"
                    rows={12}
                    value={STATUS_CARD_RULE}
                    readOnly
                    aria-label="What Clave adds to the instructions"
                    data-testid="writing-style-rule"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
      <div className="settings-row">
        <div className="min-w-0">
          {refusal && (
            <p className="status-text" data-status="error" data-testid="writing-style-refusal">
              {refusal}
            </p>
          )}
        </div>
        <div className="settings-row-controls">
          <button className="btn-secondary" onClick={onCancel} data-testid="writing-style-cancel">
            Cancel
          </button>
          {readOnly ? (
            <button
              className="btn-primary"
              onClick={() =>
                onDuplicate({
                  name: `${draft.name} copy`,
                  description: draft.description,
                  text: draft.text,
                  statusCard: draft.statusCard
                })
              }
              data-testid="writing-style-duplicate"
            >
              Duplicate
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => void save()}
              disabled={saving}
              data-testid="writing-style-save"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </SettingsCard>
  )
}

/** One style's row: its name, its description, its tags and its controls;
 *  an own style's Delete asks first, under the row. */
function StyleRow({
  machine,
  style,
  onOpen
}: {
  machine: string
  style: WritingStyle
  onOpen: (state: EditorState) => void
}): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setConfirming(false)
    setError(await deleteWritingStyle(machine, style.id))
  }
  return (
    <>
      <div className="settings-row" data-writing-style-row={style.id}>
        <div className="min-w-0">
          <p className="settings-row-title">{style.name}</p>
          {style.description && <p className="settings-row-description">{style.description}</p>}
          {(style.builtIn || style.statusCard) && (
            <div className="settings-row-tags">
              {style.builtIn && <span className="badge badge-muted">Built-in</span>}
              {style.statusCard && <span className="badge badge-muted">Status card</span>}
            </div>
          )}
        </div>
        <div className="settings-row-controls">
          {style.builtIn ? (
            <button
              className="btn-secondary"
              onClick={() => onOpen({ draft: draftOf(style), readOnly: true })}
              data-testid={`writing-style-view-${style.id}`}
            >
              View
            </button>
          ) : (
            <button
              className="btn-secondary"
              onClick={() => onOpen({ draft: draftOf(style), readOnly: false })}
              data-testid={`writing-style-edit-${style.id}`}
            >
              Edit
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() => onOpen({ draft: duplicateDraft(style), readOnly: false })}
            data-testid={`writing-style-duplicate-${style.id}`}
          >
            Duplicate
          </button>
          {!style.builtIn && (
            <button
              className="btn-secondary"
              onClick={() => setConfirming(true)}
              data-testid={`writing-style-delete-${style.id}`}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {confirming && (
        <SettingsCallout
          inset
          tone="danger"
          role="alertdialog"
          title={`Delete the style “${style.name}”?`}
          text="New tabs can no longer start with it. A tab opened with it keeps it until it is launched again."
          actions={
            <>
              <button className="btn-secondary" onClick={() => setConfirming(false)} autoFocus>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => void remove()}
                data-writing-style-delete-confirm={style.id}
              >
                Delete
              </button>
            </>
          }
        />
      )}
      {error && <SettingsCallout inset tone="danger" role="alert" text={error} />}
    </>
  )
}

/** The page's body for one machine: its styles, read when it opens. */
export function WritingStylesList({
  machine,
  machineName
}: {
  machine: string
  machineName: string
}): ReactElement {
  const state = useWritingStylesStore((s) => s.byMachine[machine] ?? EMPTY_MACHINE_STYLES)
  // The editor belongs to the machine it was opened on: a pick of another
  // machine in the picker leaves it behind.
  const [opened, setEditor] = useState<(EditorState & { key: number; machine: string }) | null>(
    null
  )
  const editor = opened?.machine === machine ? opened : null
  const [pageError, setPageError] = useState<string | null>(null)
  useEffect(() => {
    void loadWritingStyles(machine)
  }, [machine])
  // A new key remounts the editor: Duplicate from a read-only one opens a fresh draft.
  const open = (next: EditorState): void =>
    setEditor((current) => ({ ...next, machine, key: (current?.key ?? 0) + 1 }))
  const view = state.view

  if (state.status === 'error' && state.error === WRITING_STYLES_NEED_UPDATE)
    // An older server: nothing to try again, the update is the way.
    return (
      <SettingsCallout
        role="status"
        title={WRITING_STYLES_NEED_UPDATE}
        text={`${machineName} runs a Clave server released before this page. Its tabs start with no style until it is updated (Settings → Servers).`}
      />
    )
  if (state.status === 'error' && !view)
    return (
      <SettingsCallout
        tone="danger"
        role="alert"
        text={state.error ?? `${machineName} did not answer.`}
        actions={
          <button className="btn-secondary" onClick={() => void loadWritingStyles(machine)}>
            Try again
          </button>
        }
      />
    )
  if (!view)
    return (
      <SettingsCard>
        <div className="settings-row">
          <p className="settings-row-description">Reading…</p>
        </div>
      </SettingsCard>
    )

  const write = async (run: Promise<string | null>): Promise<void> => setPageError(await run)
  let editorBlock: ReactNode = null
  if (editor)
    editorBlock = (
      <WritingStyleEditor
        key={editor.key}
        initial={editor.draft}
        readOnly={editor.readOnly}
        onSave={async (draft) => {
          const refusal = await saveWritingStyle(machine, draft)
          if (!refusal) setEditor(null)
          return refusal
        }}
        onDuplicate={(draft) => open({ draft, readOnly: false })}
        onCancel={() => setEditor(null)}
      />
    )
  return (
    <>
      <SettingsSection title="New tabs">
        <SettingsCard>
          <SettingsRow
            label="Start with"
            description="A tab keeps the style it was opened with. A change here reaches the tabs opened after it."
          >
            <SettingsSelect
              value={view.defaultStyleId ?? NO_STYLE}
              options={[
                { value: NO_STYLE, label: 'No style' },
                ...view.styles.map((style) => ({ value: style.id, label: style.name }))
              ]}
              onChange={(id) =>
                void write(setDefaultWritingStyle(machine, id === NO_STYLE ? null : id))
              }
              ariaLabel="Start new tabs with"
              testId="writing-styles-default"
            />
          </SettingsRow>
        </SettingsCard>
        {pageError && <SettingsCallout tone="danger" role="alert" text={pageError} />}
      </SettingsSection>
      <SettingsSection title="Styles">
        <SettingsCard data-writing-styles={machine}>
          {view.styles.map((style) => (
            <StyleRow key={style.id} machine={machine} style={style} onOpen={open} />
          ))}
          <button
            className="settings-row-action"
            onClick={() => open({ draft: EMPTY_DRAFT, readOnly: false })}
            data-testid="writing-style-new"
          >
            <PlusIcon className="w-4 h-4" /> New style
          </button>
        </SettingsCard>
        {editorBlock}
      </SettingsSection>
      {view.claudeOutputStyle && (
        <SettingsSection title="Claude Code">
          <SettingsCard>
            <SettingsRow
              label={`Output style « ${view.claudeOutputStyle.name} »`}
              description="Claude Code uses its own output style on this machine. A tab that has a Clave style does not use it."
            >
              <button
                className="btn-secondary"
                onClick={() => void write(importClaudeOutputStyle(machine))}
                data-testid="writing-style-import-claude"
              >
                Import as a style
              </button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      )}
      <SettingsSection title="What each harness takes">
        <SettingsCard data-testid="writing-styles-support">
          {HARNESSES.map((harness) => (
            <div className="settings-row" key={harness.id} data-writing-style-support={harness.id}>
              <p className="settings-row-description">{styleSupportLine(harness)}</p>
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
    </>
  )
}

/** This Mac's Writing styles page. */
export function WritingStylesSettings(): ReactElement {
  return (
    <SettingsPage
      title="Writing styles"
      description={writingStylesDescription('this Mac')}
      testId="styles"
    >
      <WritingStylesList machine={LOCAL_SERVER_ID} machineName="this Mac" />
    </SettingsPage>
  )
}
