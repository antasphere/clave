// Temporary (tmp/specimen, never PR #341): Help → Component specimen, dev
// builds only. Every UI primitive on one page, drawn with the real classes and
// the real components, in every state that can be shown without a pointer, so
// the paper rules (b6a70389) can be judged live, per skin, against Before.
import { useEffect, useState } from 'react'
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CommandLineIcon,
  Cog6ToothIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  PaperClipIcon,
  PlusIcon,
  Squares2X2Icon,
  TrashIcon,
  XMarkIcon,
  CheckIcon,
  PencilIcon
} from '@heroicons/react/24/outline'
import { ConfirmDialog } from '@clave/ui/components'
import { skinAction, useSkinStore } from '../../lib/skin'
import {
  Radio,
  SettingsCallout,
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  Toggle,
  ToggleRow
} from '../settings/primitives'
import beforeCss from './before/main.css?inline'

const BEFORE_ID = 'specimen-before-css'
let disabledSheets: CSSStyleSheet[] = []

/** Does this sheet carry the design system? Searched through @layer and
 *  @media blocks, since Tailwind nests some of what it emits. */
function carriesSystem(rules: CSSRuleList): boolean {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule && rule.selectorText === '.settings-card') return true
    if ('cssRules' in rule && carriesSystem((rule as CSSGroupingRule).cssRules)) return true
  }
  return false
}

/** Before: the live bundle (Tailwind + @clave/ui + main.css) is DISABLED and
 *  the same bundle compiled from the pre-paper sources takes its place, so no
 *  rule the paper commit added can survive into Before (appending the old
 *  sheet alone would leave e.g. the fields' hairline box-shadow, which the
 *  old rules never set). After: the old sheet goes, the live one returns. */
function setBefore(on: boolean): void {
  document.getElementById(BEFORE_ID)?.remove()
  for (const sheet of disabledSheets) sheet.disabled = false
  disabledSheets = []
  if (!on) return
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (carriesSystem(sheet.cssRules)) {
        sheet.disabled = true
        disabledSheets.push(sheet)
      }
    } catch {
      /* a cross-origin sheet: not ours */
    }
  }
  const style = document.createElement('style')
  style.id = BEFORE_ID
  style.textContent = beforeCss
  document.head.appendChild(style)
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="specimen-section">
      <h2 className="settings-section-title" style={{ marginBottom: 12 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Cell({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  )
}

const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 20,
  alignItems: 'start'
}

/** A field that shows its focus without being focused: the specimen marks it
 *  and the page's own rule (below) gives it the class's :focus look. */
const FOCUS_ATTR = { 'data-specimen-focus': '' }

export function Specimen(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [before, setBeforeState] = useState(false)
  const { skins, activeId } = useSkinStore()
  const [toggle, setToggle] = useState(true)
  const [radio, setRadio] = useState('a')
  const [select, setSelect] = useState<'global' | 'claude' | 'codex'>('global')
  const [segment, setSegment] = useState('group')
  const [confirm, setConfirm] = useState(false)

  useEffect(() => window.electronAPI.onOpenSpecimen(() => setOpen(true)), [])
  useEffect(() => {
    setBefore(open && before)
  }, [open, before])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !confirm) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, confirm])

  if (!open) return null

  return (
    <div className="specimen-root" data-testid="specimen">
      {/* Forced focus: the :focus rule of each class, copied onto a marker
          attribute so a still page can show it. Written once per state the
          paper rules define; in Before the old classes have no such rule,
          so this restates the old one (an accent border). */}
      <style>{before ? BEFORE_FOCUS : AFTER_FOCUS}</style>
      <header className="specimen-bar">
        <strong style={{ fontSize: 13 }}>Component specimen</strong>
        <div className="segmented" role="radiogroup" aria-label="Skin">
          {skins.map((s) => (
            <button
              key={s.id}
              type="button"
              className="segmented-item"
              data-active={activeId === s.id ? 'true' : undefined}
              data-specimen-skin={s.id}
              onClick={() => void skinAction(() => window.electronAPI.skinsActivate(s.id))}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Before or after">
          <button
            type="button"
            className="segmented-item"
            data-active={before ? 'true' : undefined}
            data-specimen-mode="before"
            onClick={() => setBeforeState(true)}
          >
            Before
          </button>
          <button
            type="button"
            className="segmented-item"
            data-active={!before ? 'true' : undefined}
            data-specimen-mode="after"
            onClick={() => setBeforeState(false)}
          >
            After (paper)
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          {before ? 'Before: the whole app, pre-b6a70389' : 'After: paper'}
        </span>
        <button
          type="button"
          className="btn-icon btn-icon-md"
          aria-label="Close specimen"
          title="Close (Esc)"
          onClick={() => setOpen(false)}
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </header>

      <div className="specimen-scroll">
        <div className="specimen-page">
          <Section title="Sidebar controls (the reference)">
            <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
              <Cell label="Launcher panel">
                <div className="launcher-panel" style={{ width: 250 }}>
                  <div className="launcher-row">
                    <button type="button" className="launcher-btn">
                      <CommandLineIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span>Terminal</span>
                    </button>
                    <span className="launcher-sep" aria-hidden="true" />
                    <div className="launcher-split">
                      <button type="button" className="launcher-btn">
                        <span className="truncate">Claude</span>
                      </button>
                      <button type="button" className="launcher-caret" aria-label="More">
                        <ChevronDownIcon className="w-3 h-3" />
                      </button>
                    </div>
                    <button type="button" className="launcher-icon-btn" aria-label="Folder">
                      <FolderIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </Cell>
              <Cell label="Group switcher">
                <div className="group-switcher-panel" style={{ width: 250 }}>
                  <div className="group-switcher-head">
                    <button type="button" className="group-switcher-chip" data-selected="true">
                      <Squares2X2Icon className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>All</span>
                    </button>
                    <div className="group-switcher-search">
                      <MagnifyingGlassIcon className="w-3.5 h-3.5 flex-shrink-0" />
                      <input type="text" placeholder="Search groups" aria-label="Search groups" />
                    </div>
                  </div>
                </div>
              </Cell>
              <Cell label="Sidebar rows: rest, selected">
                <div style={{ width: 250 }}>
                  <button type="button" className="sidebar-item">
                    <span className="truncate">clave-app</span>
                  </button>
                  <button type="button" className="sidebar-item" data-selected="true">
                    <span className="truncate">wt-harmonize</span>
                  </button>
                  <div className="sidebar-empty-row">No sessions</div>
                </div>
              </Cell>
              <Cell label="Sidebar foot panel">
                <div className="sidebar-panel sidebar-footer" style={{ width: 250 }}>
                  <div className="sidebar-footer-row sidebar-footer-row--user">
                    <span style={{ fontSize: 13 }}>Romain Pattyn</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="sidebar-footer-btn" aria-label="Settings">
                      <Cog6ToothIcon className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="sidebar-footer-sep" />
                  <div className="sidebar-footer-row sidebar-footer-row--meta">
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      Claude Code · Usage unavailable
                    </span>
                  </div>
                </div>
              </Cell>
            </div>
          </Section>

          <Section title="Inputs and textareas">
            <div style={grid}>
              <Cell label=".input-compact">
                <input className="input-compact" placeholder="Rename the tab" aria-label="a" />
              </Cell>
              <Cell label=".input-compact with a value">
                <input className="input-compact" defaultValue="Romain Pattyn" aria-label="b" />
              </Cell>
              <Cell label=".input-compact focused">
                <input
                  className="input-compact"
                  defaultValue="Romain Pattyn"
                  aria-label="c"
                  {...FOCUS_ATTR}
                />
              </Cell>
              <Cell label=".input-compact invalid">
                <input
                  className="input-compact"
                  defaultValue="not a branch"
                  aria-invalid="true"
                  aria-label="d"
                />
              </Cell>
              <Cell label=".input-compact disabled">
                <input className="input-compact" defaultValue="50" disabled aria-label="e" />
              </Cell>
              <Cell label=".input-field">
                <input className="input-field" placeholder="you@example.com" aria-label="f" />
              </Cell>
              <Cell label=".input-field focused">
                <input
                  className="input-field"
                  defaultValue="romain@antasphere.com"
                  aria-label="g"
                  {...FOCUS_ATTR}
                />
              </Cell>
              <Cell label=".textarea-field">
                <textarea
                  className="textarea-field"
                  rows={3}
                  placeholder="What works, what doesn't, what's missing…"
                  aria-label="h"
                />
              </Cell>
              <Cell label=".textarea-field focused">
                <textarea
                  className="textarea-field"
                  rows={3}
                  defaultValue="The fields look like Clave now."
                  aria-label="i"
                  {...FOCUS_ATTR}
                />
              </Cell>
              <Cell label=".search-field (standalone)">
                <div className="search-field" style={{ width: '100%' }}>
                  <MagnifyingGlassIcon className="w-3.5 h-3.5 flex-shrink-0" />
                  <input type="text" placeholder="Filter files" aria-label="j" />
                </div>
              </Cell>
            </div>
          </Section>

          <Section title="Selects">
            <div style={grid}>
              <Cell label="SettingsSelect (opens the real menu)">
                <SettingsSelect
                  value={select}
                  ariaLabel="Default profile"
                  onChange={setSelect}
                  options={[
                    { value: 'global', label: 'Use global default' },
                    { value: 'claude', label: 'Claude Code' },
                    { value: 'codex', label: 'Codex' }
                  ]}
                />
              </Cell>
              <Cell label="open">
                <button type="button" className="select-trigger" data-state="open">
                  <span className="select-trigger-label">No profile</span>
                  <ChevronDownIcon className="select-trigger-caret" />
                </button>
              </Cell>
              <Cell label="focused (keyboard)">
                <button type="button" className="select-trigger" data-specimen-keyfocus="">
                  <span className="select-trigger-label">Antigravity</span>
                  <ChevronDownIcon className="select-trigger-caret" />
                </button>
              </Cell>
              <Cell label="disabled">
                <SettingsSelect
                  value="global"
                  ariaLabel="x"
                  disabled
                  onChange={() => {}}
                  options={[{ value: 'global', label: 'Use global default' }]}
                />
              </Cell>
            </div>
          </Section>

          <Section title="Buttons">
            <div style={grid}>
              <Cell label=".btn-primary: rest, focused, disabled">
                <button type="button" className="btn-primary">
                  Save
                </button>
                <button type="button" className="btn-primary" data-specimen-keyfocus="">
                  Send
                </button>
                <button type="button" className="btn-primary" disabled>
                  Create
                </button>
              </Cell>
              <Cell label=".btn-secondary: rest, focused, disabled">
                <button type="button" className="btn-secondary">
                  Redraw
                </button>
                <button type="button" className="btn-secondary" data-specimen-keyfocus="">
                  Import skin
                </button>
                <button type="button" className="btn-secondary" disabled>
                  Edit
                </button>
              </Cell>
              <Cell label=".btn-compact">
                <button type="button" className="btn-primary btn-compact">
                  Allow
                </button>
                <button type="button" className="btn-secondary btn-compact">
                  Cancel
                </button>
              </Cell>
              <Cell label=".btn-icon xs / sm / md, danger, disabled">
                <button type="button" className="btn-icon btn-icon-xs" aria-label="1">
                  <XMarkIcon className="w-3 h-3" />
                </button>
                <button type="button" className="btn-icon btn-icon-sm" aria-label="2">
                  <PencilIcon className="w-3.5 h-3.5" />
                </button>
                <button type="button" className="btn-icon btn-icon-md" aria-label="3">
                  <Cog6ToothIcon className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  className="btn-icon btn-icon-sm btn-icon--danger"
                  aria-label="4"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
                <button type="button" className="btn-icon btn-icon-sm" disabled aria-label="5">
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </Cell>
              <Cell label=".btn-add">
                <button type="button" className="btn-add">
                  <PlusIcon className="w-3.5 h-3.5" />
                  Add workspace
                </button>
              </Cell>
              <Cell label=".settings-row-action">
                <div className="settings-card" style={{ width: '100%' }}>
                  <button type="button" className="settings-row-action">
                    <PlusIcon className="w-3.5 h-3.5" />
                    Add profile
                  </button>
                </div>
              </Cell>
            </div>
          </Section>

          <Section title="Switches, radios, checkboxes">
            <div style={grid}>
              <Cell label="Toggle: on, off, disabled">
                <Toggle checked={toggle} onChange={setToggle} ariaLabel="t1" />
                <Toggle checked={!toggle} onChange={(v) => setToggle(!v)} ariaLabel="t2" />
                <Toggle checked disabled onChange={() => {}} ariaLabel="t3" />
                <Toggle checked={false} disabled onChange={() => {}} ariaLabel="t4" />
              </Cell>
              <Cell label="Toggle focused">
                <button
                  type="button"
                  role="switch"
                  aria-checked
                  className="switch"
                  data-checked="true"
                  data-specimen-keyfocus=""
                >
                  <span className="switch-knob" />
                </button>
              </Cell>
              <Cell label="Radio: checked, unchecked, focused">
                <Radio checked={radio === 'a'} onSelect={() => setRadio('a')} ariaLabel="r1" />
                <Radio checked={radio === 'b'} onSelect={() => setRadio('b')} ariaLabel="r2" />
                <button
                  type="button"
                  role="radio"
                  aria-checked={false}
                  className="radio"
                  data-specimen-keyfocus=""
                  aria-label="r3"
                />
              </Cell>
              <Cell label="Native checkbox (markdown task lists; no class of its own)">
                <label style={{ display: 'flex', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" defaultChecked /> Done
                </label>
                <label style={{ display: 'flex', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" /> To do
                </label>
              </Cell>
            </div>
          </Section>

          <Section title="Segmented controls">
            <div style={grid}>
              <Cell label=".segmented">
                <div className="segmented">
                  {['workspace', 'group', 'session'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="segmented-item"
                      data-active={segment === s ? 'true' : undefined}
                      onClick={() => setSegment(s)}
                    >
                      {s[0].toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </Cell>
              <Cell label="focused segment">
                <div className="segmented">
                  <button type="button" className="segmented-item" data-active="true">
                    Logo
                  </button>
                  <button type="button" className="segmented-item" data-specimen-keyfocus="">
                    Orb
                  </button>
                </div>
              </Cell>
            </div>
          </Section>

          <Section title="Settings cards and rows">
            <SettingsCard>
              <SettingsRow
                label="Name"
                description="Shown at the foot of the sidebar and to the agents."
              >
                <input
                  className="input-compact w-48"
                  defaultValue="Romain Pattyn"
                  aria-label="Your name"
                />
              </SettingsRow>
              <ToggleRow
                label="Persistent sessions (tmux)"
                description="Sessions keep running after you quit Clave."
                checked={toggle}
                onChange={setToggle}
              />
              <SettingsRow label="Default account" description="Machine login · ~/.claude">
                <Radio checked onSelect={() => {}} ariaLabel="default" />
              </SettingsRow>
              <SettingsRow label="Global default">
                <SettingsSelect
                  value={select}
                  ariaLabel="Global default"
                  onChange={setSelect}
                  options={[
                    { value: 'global', label: 'Use global default' },
                    { value: 'claude', label: 'Claude Code' },
                    { value: 'codex', label: 'Codex' }
                  ]}
                />
              </SettingsRow>
              <SettingsRow
                label="Echo (development)"
                description="echo"
                tags={<span className="badge badge-muted">Built in</span>}
              >
                <button type="button" className="btn-secondary">
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-icon btn-icon-sm btn-icon--danger"
                  aria-label="Delete"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              </SettingsRow>
              <SettingsRow
                label="Disabled row"
                description="A row the current state switches off."
                disabled
              >
                <Toggle checked={false} disabled onChange={() => {}} ariaLabel="off" />
              </SettingsRow>
              <SettingsCallout
                inset
                tone="accent"
                title="Inset callout"
                text="A confirmation attached to the row above it."
              />
              <button type="button" className="settings-row-action">
                <PlusIcon className="w-3.5 h-3.5" />
                Add profile
              </button>
            </SettingsCard>
          </Section>

          <Section title="Callouts">
            <div style={{ display: 'grid', gap: 10 }}>
              <SettingsCallout
                title="Plain callout"
                text="A confirmation, a picker, an error under a card."
                actions={
                  <>
                    <button type="button" className="btn-secondary">
                      Cancel
                    </button>
                    <button type="button" className="btn-primary">
                      Confirm
                    </button>
                  </>
                }
              />
              <SettingsCallout
                tone="accent"
                title="Accent callout"
                text="This server can't run sessions yet."
              />
              <SettingsCallout
                tone="danger"
                title="Danger callout"
                text="Removing this account signs it out everywhere."
                actions={
                  <>
                    <button type="button" className="btn-secondary">
                      Cancel
                    </button>
                    <button type="button" className="btn-primary">
                      Remove
                    </button>
                  </>
                }
              />
            </div>
          </Section>

          <Section title="Badges and pills">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="badge badge-muted">Built in</span>
              <span className="badge badge-muted">Active</span>
              <span className="badge badge-muted badge-uppercase">Beta</span>
              <span className="pill">opus</span>
              <span className="pill pill-muted">high</span>
              <span className="status-text" data-status="connected">
                Connected
              </span>
              <span className="status-text" data-status="connecting">
                Connecting…
              </span>
              <span className="status-text" data-status="error">
                Failed
              </span>
            </div>
          </Section>

          <Section title="Menus and popovers (statically open)">
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div className="menu-surface p-1" style={{ width: 240 }}>
                <div className="menu-label">Select model</div>
                <div className="menu-item" data-selected="true">
                  Echo 1<CheckIcon className="w-3.5 h-3.5 ml-auto text-accent" />
                </div>
                <div className="menu-item" data-highlighted="">
                  Echo 2 (highlighted)
                </div>
                <div className="menu-item">
                  Claude Code<span className="menu-hint ml-auto">⌘I</span>
                </div>
                <div className="menu-item" data-disabled="">
                  Disabled row
                </div>
                <div className="menu-sep" />
                <div className="menu-item menu-item--muted">Manage profiles…</div>
                <div className="menu-item menu-item--danger">Close tab</div>
              </div>
              <div className="menu-surface menu-surface--sheet p-4" style={{ width: 300 }}>
                <p className="settings-callout-title">Sheet tier</p>
                <p className="settings-callout-text">
                  A document-sized surface: the file preview, the diff.
                </p>
              </div>
            </div>
          </Section>

          <Section title="Dialog body">
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div className="modal-card" style={{ width: 420 }}>
                <div style={{ padding: 24, display: 'grid', gap: 12 }}>
                  <p style={{ fontWeight: 600, fontSize: 14 }}>Help us make Clave better</p>
                  <button type="button" className="btn-primary" style={{ width: '100%' }}>
                    Book a 30 min call
                  </button>
                  <div>
                    <label className="field-label">Leave us your email</label>
                    <input className="input-field" placeholder="you@example.com" />
                  </div>
                  <div>
                    <label className="field-label">Anything you want to tell us</label>
                    <textarea
                      className="textarea-field"
                      rows={3}
                      placeholder="What works, what doesn't, what's missing…"
                    />
                  </div>
                </div>
                <div className="border-t border-border-subtle flex">
                  <button
                    type="button"
                    className="btn-dialog text-text-secondary border-r border-border-subtle"
                  >
                    Cancel
                  </button>
                  <button type="button" className="btn-dialog">
                    Send
                  </button>
                </div>
              </div>
              <Cell label="The real ConfirmDialog">
                <button type="button" className="btn-secondary" onClick={() => setConfirm(true)}>
                  Open ConfirmDialog
                </button>
              </Cell>
            </div>
            <ConfirmDialog
              isOpen={confirm}
              title="Remove this workspace?"
              message="Its sessions keep running; only the entry goes."
              confirmLabel="Remove"
              onConfirm={() => setConfirm(false)}
              onCancel={() => setConfirm(false)}
            />
          </Section>

          <Section title="Theme swatches (real: click one)">
            <div style={{ display: 'flex', gap: 12 }}>
              {skins.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void skinAction(() => window.electronAPI.skinsActivate(t.id))}
                  className="theme-swatch"
                  data-selected={activeId === t.id ? 'true' : undefined}
                >
                  <div
                    className="theme-swatch-preview"
                    data-theme={t.skin.base}
                    style={t.tokens as React.CSSProperties}
                  >
                    <div className="theme-swatch-line w-10 mb-2" style={{ opacity: 0.7 }} />
                    <div className="flex gap-1.5">
                      <div className="theme-swatch-tile" />
                      <div className="theme-swatch-tile" />
                    </div>
                  </div>
                  <div className="theme-swatch-label">{t.name}</div>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Chat composer: rest, with the caret">
            <div style={{ display: 'grid', gap: 16, ['--chat-column' as string]: '48rem' }}>
              {[false, true].map((focused) => (
                <div key={String(focused)} className="chat-composer-wrap" style={{ padding: 0 }}>
                  <form
                    className="chat-composer"
                    onSubmit={(e) => e.preventDefault()}
                    data-specimen-within={focused ? '' : undefined}
                  >
                    <textarea
                      rows={1}
                      placeholder="Write a message…"
                      defaultValue={focused ? 'Harmonize the primitives with the sidebar' : ''}
                      aria-label="Message"
                    />
                    <button type="submit" className="chat-send" data-kind="send" aria-label="Send">
                      <ArrowUpIcon data-glyph="send" />
                    </button>
                  </form>
                  <div className="chat-composer-footer">
                    <span className="chat-composer-hint">
                      <button type="button" className="chat-composer-tool" aria-label="Add files">
                        <PaperClipIcon />
                      </button>
                    </span>
                    <div className="chat-composer-controls">
                      <button type="button" className="chat-model-trigger">
                        Echo 1<ChevronDownIcon className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}

/* The specimen's own frame, and forced focus. AFTER restates the paper
   :focus / :focus-visible rules; BEFORE restates the pre-paper ones. */
const FRAME = `
.specimen-root { position: fixed; inset: 0; z-index: 90; display: flex; flex-direction: column; background: var(--surface-0); color: var(--text-primary); }
.specimen-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px 10px 88px; border-bottom: 1px solid var(--color-border); -webkit-app-region: drag; }
.specimen-bar > * { -webkit-app-region: no-drag; }
.specimen-scroll { flex: 1; overflow-y: auto; }
.specimen-page { max-width: 1080px; margin: 0 auto; padding: 28px 32px 80px; display: grid; gap: 36px; }
`
const AFTER_FOCUS =
  FRAME +
  `
:is(.input-field, .textarea-field, .input-compact)[data-specimen-focus] { box-shadow: var(--focus-ring); }
[data-specimen-keyfocus]:is(.btn-primary, .btn-secondary, .select-trigger, .switch, .radio, .segmented-item) { outline: none; box-shadow: var(--focus-ring); }
.chat-composer[data-specimen-within] { box-shadow: 0 0 0 1px var(--color-border), var(--raised-shadow); }
`
const BEFORE_FOCUS =
  FRAME +
  `
:is(.input-field, .textarea-field)[data-specimen-focus] { border-color: var(--color-accent); }
.input-compact[data-specimen-focus] { border-color: var(--color-accent); box-shadow: 0 0 0 1px var(--color-accent); }
[data-specimen-keyfocus]:is(.btn-primary, .btn-secondary, .select-trigger, .switch, .radio, .segmented-item) { outline: 1.5px solid var(--color-accent); outline-offset: -1.5px; }
.chat-composer[data-specimen-within] { border-color: var(--color-border); }
`
