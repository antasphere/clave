import {
  inActiveWorkspace,
  isFileTabId,
  useSessionStore,
  type ExtensionsSection,
  type SettingsSection
} from '../store/session-store'
import { findWorkspace, useWorkspaceStore } from '../store/workspace-store'
import { isShown, useArtefactStore } from '../store/artefact-store'
import { useLinkedDocumentStore } from '../store/linked-document-store'
import { pluginPanels, usePluginUIStore } from '../components/plugins/plugin-ui-store'
import type { PluginRecord } from '../../../main/plugins/plugin-store'
import type { LinkedDocument } from '../../../shared/linked-documents'
import { setActiveWorkspace } from './workspace-actions'
import { getRegisteredTerminal } from './terminal-registry'
import { EXTENSIONS_SECTION_LABELS, SETTINGS_SECTION_LABELS } from './view-sections'
import type { BesideCard, Place, PlacePlugin } from './navigation-history'

/**
 * A place read off the stores and put back on them (PRDCT-5155): the
 * adapters between the pure history (`navigation-history.ts`) and the
 * window. What a place holds is decided here the way the content column
 * decides what it draws, so the history steps through what the person saw.
 */

type SessionState = ReturnType<typeof useSessionStore.getState>

const tabExists = (s: SessionState, id: string): boolean =>
  s.sessions.some((session) => session.id === id) || s.fileTabs.some((tab) => tab.id === id)

const groupHasView = (s: SessionState, id: string): boolean =>
  s.groups.some((group) => group.id === id && !!group.view)

const tabHasView = (s: SessionState, id: string): boolean =>
  s.sessions.some((session) => session.id === id && !!session.view)

const isSettingsSection = (section: string | null): section is SettingsSection =>
  section !== null && Object.hasOwn(SETTINGS_SECTION_LABELS, section)

const isExtensionsSection = (section: string | null): section is ExtensionsSection =>
  section !== null && Object.hasOwn(EXTENSIONS_SECTION_LABELS, section)

/** A plugin is running when it is switched on and active, as the plugin hosts judge it
 *  (`pluginPanels` in plugin-ui-store); a main panel also needs its panel registered. */
function pluginRunning(plugin: PlacePlugin, records: PluginRecord[]): boolean {
  if (plugin.kind === 'panel') {
    return pluginPanels(records, 'main').some(
      (entry) => entry.pluginId === plugin.pluginId && entry.panelId === plugin.panelId
    )
  }
  return records.some(
    (record) =>
      record.id === plugin.page.pluginId &&
      record.enabled &&
      record.status === 'active' &&
      !!record.manifest
  )
}

/** The plugin page or main panel covering the content column, as `PluginMainPanel` draws it:
 *  a page whenever one is open, a main panel only while its plugin runs. */
function coveringPlugin(): PlacePlugin | null {
  const { page, mainPanel, records } = usePluginUIStore.getState()
  if (page) return { kind: 'page', page }
  if (!mainPanel) return null
  const panel: PlacePlugin = {
    kind: 'panel',
    pluginId: mainPanel.pluginId,
    panelId: mainPanel.panelId
  }
  return pluginRunning(panel, records) ? panel : null
}

/** What the pane draws beside a session shown alone, in TerminalGrid's order: its visible
 *  linked document first, else its artefact when shown, else nothing. */
function cardBeside(sessionId: string): BesideCard | null {
  const doc = useLinkedDocumentStore
    .getState()
    .documents.find((d) => d.sessionId === sessionId && !d.hidden)
  if (doc) return { kind: 'document', id: doc.id }
  const { artefacts, hidden } = useArtefactStore.getState()
  const artefact = artefacts[sessionId]
  if (artefact && isShown(artefact, hidden)) {
    return { kind: 'artefact', id: artefact.target, openedAt: artefact.openedAt }
  }
  return null
}

/** The place on screen now. */
export function readPlace(): Place {
  const s = useSessionStore.getState()
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
  const view = s.activeView
  // Re-validated as TerminalGrid does: a stale id (the group gone, the view detached, the
  // workspace switched) draws the mosaic, so it is no part of the place.
  const groupView =
    s.activeGroupViewId !== null &&
    s.groups.some(
      (g) => g.id === s.activeGroupViewId && g.view && inActiveWorkspace(g, workspaceId)
    )
      ? s.activeGroupViewId
      : null
  const tabView =
    s.activeSessionViewId !== null &&
    s.sessions.some(
      (x) => x.id === s.activeSessionViewId && x.view && inActiveWorkspace(x, workspaceId)
    )
      ? s.activeSessionViewId
      : null
  const plugin = coveringPlugin()
  const tabs = [...s.selectedSessionIds]
  // A card shows beside a tab shown alone in the uncovered mosaic, never beside the tiles
  // of a mosaic of several (`alone` in TerminalGrid). A file tab never has one.
  const alone =
    view === 'terminals' &&
    plugin === null &&
    groupView === null &&
    tabView === null &&
    tabs.length === 1
  return {
    workspaceId,
    view,
    section:
      view === 'settings' ? s.settingsSection : view === 'extensions' ? s.extensionsSection : null,
    tabs,
    focused: s.focusedSessionId,
    groupView,
    tabView,
    plugin,
    beside: !alone ? null : isFileTabId(tabs[0]) ? {} : { [tabs[0]]: cardBeside(tabs[0]) }
  }
}

/** Whether going to the place would still show something: its workspace exists, and for the
 *  mosaic, one of its tabs or the page over them still does. A plugin that stopped does not
 *  kill a place that has more to show (the restore leaves the page out); a place that is
 *  nothing but a plugin's page lives while the plugin runs. */
export function placeAlive(p: Place): boolean {
  if (p.workspaceId !== null && !findWorkspace(useWorkspaceStore.getState(), p.workspaceId)) {
    return false
  }
  if (p.view !== 'terminals') return true
  const s = useSessionStore.getState()
  if (p.tabs.some((id) => tabExists(s, id))) return true
  if (p.groupView !== null && groupHasView(s, p.groupView)) return true
  if (p.tabView !== null && tabHasView(s, p.tabView)) return true
  return p.plugin !== null && pluginRunning(p.plugin, usePluginUIStore.getState().records)
}

/** Put a plugin's page or panel back over the column when its plugin still runs; with none,
 *  or a plugin that stopped, close what covers the column. */
function applyPlugin(plugin: PlacePlugin | null): void {
  const ui = usePluginUIStore.getState()
  if (plugin && pluginRunning(plugin, ui.records)) {
    if (plugin.kind === 'page') ui.openPage(plugin.page)
    else ui.openMainPanel({ pluginId: plugin.pluginId, panelId: plugin.panelId })
    return
  }
  if (ui.page !== null) ui.openPage(null)
  if (ui.mainPanel !== null) ui.openMainPanel(null)
}

/** Put back what showed beside each tab still there. The pane draws one card at a time
 *  (`latest-opened-wins.ts`, left as it is): an artefact put back also hides the session's
 *  visible document here, at once, so the place read right after the restore is the settled
 *  one; a document put back is enough by itself, since the document is what the pane draws
 *  first. */
async function applyBeside(
  beside: Record<string, BesideCard | null>,
  live: readonly string[]
): Promise<void> {
  const documents = useLinkedDocumentStore.getState().documents
  const updates: Array<Promise<LinkedDocument>> = []
  const setDocumentHidden = (id: string, revision: number, hidden: boolean): void => {
    updates.push(window.electronAPI.linkedDocuments.update(id, revision, { hidden }))
  }
  for (const sessionId of live) {
    if (!Object.hasOwn(beside, sessionId)) continue
    const card = beside[sessionId]
    const visible = documents.filter((d) => d.sessionId === sessionId && !d.hidden)
    if (card === null) {
      const { artefacts, hidden, setHidden } = useArtefactStore.getState()
      const shown = artefacts[sessionId]
      if (shown && isShown(shown, hidden)) setHidden(sessionId, shown.openedAt)
      for (const doc of visible) setDocumentHidden(doc.id, doc.revision, true)
    } else if (card.kind === 'artefact') {
      const store = useArtefactStore.getState()
      if (!(store.lists[sessionId] ?? []).some((a) => a.target === card.id)) continue
      if (store.artefacts[sessionId]?.target !== card.id) store.pick(sessionId, card.id)
      const after = useArtefactStore.getState()
      const shown = after.artefacts[sessionId]
      if (shown && !isShown(shown, after.hidden)) after.setHidden(sessionId, null)
      for (const doc of visible) setDocumentHidden(doc.id, doc.revision, true)
    } else {
      const doc = documents.find((d) => d.id === card.id && d.sessionId === sessionId)
      if (doc?.hidden) setDocumentHidden(doc.id, doc.revision, false)
    }
  }
  if (updates.length === 0) return
  const answered = new Map<string, LinkedDocument>()
  for (const result of await Promise.allSettled(updates)) {
    if (result.status === 'fulfilled') answered.set(result.value.id, result.value)
    else console.warn('[navigation] a linked document was not changed:', result.reason)
  }
  // What main answered goes into the store at once. The refresh below may be overtaken by
  // one another change started (the pane's own rule hiding the same document), and the
  // store would then lag until that one answers: the place read right after the restore
  // would be the old one, and its late correction a move of its own.
  if (answered.size > 0) {
    useLinkedDocumentStore.setState((state) => ({
      documents: state.documents.map((d) => answered.get(d.id) ?? d)
    }))
  }
  await useLinkedDocumentStore
    .getState()
    .refresh()
    .catch((error) => console.warn('[navigation] the linked documents were not read:', error))
}

/**
 * Show the place again: its workspace first (the switch tells main before anything changes
 * in the window), then its tabs and the one focused, the group's or tab's page over them,
 * the view, the plugin covering the column, and what showed beside the tab. What is gone is
 * left out; the caller reads back what actually showed. False when the workspace could not
 * be switched to: then nothing changed.
 */
export async function applyPlace(p: Place): Promise<boolean> {
  const workspaces = useWorkspaceStore.getState()
  if (
    p.workspaceId !== null &&
    p.workspaceId !== workspaces.activeWorkspaceId &&
    findWorkspace(workspaces, p.workspaceId)
  ) {
    await setActiveWorkspace(p.workspaceId)
    if (useWorkspaceStore.getState().activeWorkspaceId !== p.workspaceId) return false
  }

  // `selectSessions` closes a plugin page and clears the group and tab pages: the steps
  // after it put back what the place had.
  const live = p.tabs.filter((id) => tabExists(useSessionStore.getState(), id))
  if (live.length > 0) {
    useSessionStore.getState().selectSessions(live)
    useSessionStore
      .getState()
      .setFocusedSession(p.focused !== null && live.includes(p.focused) ? p.focused : live[0])
  }

  const s = useSessionStore.getState()
  if (p.groupView !== null && groupHasView(s, p.groupView)) s.setActiveGroupView(p.groupView)
  else if (p.tabView !== null && tabHasView(s, p.tabView)) s.setActiveSessionView(p.tabView)
  else {
    // With none of its tabs left, nothing above cleared the page of the place being left.
    if (s.activeGroupViewId !== null) s.setActiveGroupView(null)
    if (s.activeSessionViewId !== null) s.setActiveSessionView(null)
  }

  if (p.view === 'settings') s.openSettings(isSettingsSection(p.section) ? p.section : undefined)
  else if (p.view === 'extensions') {
    s.openExtensions(isExtensionsSection(p.section) ? p.section : undefined)
  } else s.setActiveView(p.view)

  // Before the cards, which wait on main: the column never renders under a page the place
  // did not have. (A place with a card has no plugin: the card shows only uncovered.)
  applyPlugin(p.plugin)

  if (p.beside !== null) await applyBeside(p.beside, live)
  return true
}

/** How long the keyboard waits after a restore: a tab the restore put on screen is inert
 *  until React has drawn it, and the terminal pane waits as long before it focuses. */
const FOCUS_DELAY_MS = 50

/**
 * Give the keyboard to the place shown, where a click on its tab's row sends it: the focused
 * tab's terminal, or for a tab whose pane is a view (a chat tab) its visible composer. Each
 * pane focuses itself only when its tab BECOMES the focused one (a chat view also when its pane
 * comes back on screen), so a restore that kept the focused tab on screen (Back from Settings,
 * a page or a plugin's page to the mosaic under it; from a mosaic to its focused chat tab
 * alone) left the keyboard on the button that moved, and typing reached nothing. A document
 * being edited beside the tab keeps the keyboard, as it does for the pane; a move made
 * meanwhile wins.
 */
export function focusPlace(p: Place): void {
  if (p.view !== 'terminals' || p.plugin || p.groupView || p.tabView || p.focused === null) return
  const id = p.focused
  setTimeout(() => {
    if (useSessionStore.getState().focusedSessionId !== id) return
    if (document.activeElement?.closest('[data-testid="linked-document-panel"]')) return
    const terminal = getRegisteredTerminal(id)
    if (terminal) {
      terminal.focus()
      return
    }
    // Every view of the session stays mounted, one on screen: its composer is the one laid
    // out (as the pane's own search gives the keyboard back, views/registry.tsx).
    const composers = document.querySelectorAll<HTMLTextAreaElement>(
      `.chat-host[data-session-id="${CSS.escape(id)}"] textarea`
    )
    ;[...composers].find((el) => el.offsetParent !== null)?.focus()
  }, FOCUS_DELAY_MS)
}

// ── The label of a place, for the lists behind Back and Forward ──

/** What a place is, for its icon in the lists. */
export type PlaceKind =
  | 'tab'
  | 'tabs'
  | 'file'
  | 'group-page'
  | 'tab-page'
  | 'plugin'
  | 'settings'
  | 'agents'
  | 'extensions'
  | 'ongoing'
  | 'artefact'
  | 'document'

const lastSegment = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function tabName(s: SessionState, id: string): string | null {
  const session = s.sessions.find((x) => x.id === id)
  if (session) return session.name
  const file = s.fileTabs.find((f) => f.id === id)
  return file ? file.name || lastSegment(file.filePath) : null
}

function pluginTitle(plugin: PlacePlugin): string {
  if (plugin.kind === 'page') return plugin.page.title
  const record = usePluginUIStore.getState().records.find((r) => r.id === plugin.pluginId)
  const panel = record?.manifest?.contributes.panels?.find((x) => x.id === plugin.panelId)
  return panel?.title ?? plugin.panelId
}

function cardTitle(sessionId: string, card: BesideCard): string {
  if (card.kind === 'document') {
    const doc = useLinkedDocumentStore.getState().documents.find((d) => d.id === card.id)
    return doc?.title ?? 'Document'
  }
  const artefact = useArtefactStore.getState().lists[sessionId]?.find((a) => a.target === card.id)
  return artefact?.title ?? lastSegment(card.id)
}

function describePlace(p: Place): { label: string; kind: PlaceKind } {
  // A plugin covers whatever else the column holds, Settings included (AppShell).
  if (p.plugin) return { label: pluginTitle(p.plugin), kind: 'plugin' }
  switch (p.view) {
    case 'settings': {
      const section = isSettingsSection(p.section) ? SETTINGS_SECTION_LABELS[p.section] : null
      return { label: section ? `Settings · ${section}` : 'Settings', kind: 'settings' }
    }
    case 'extensions': {
      const section = isExtensionsSection(p.section) ? EXTENSIONS_SECTION_LABELS[p.section] : null
      return { label: section ? `Extensions · ${section}` : 'Extensions', kind: 'extensions' }
    }
    case 'agents':
      return { label: 'Agents', kind: 'agents' }
    case 'ongoing':
      return { label: 'Ongoing', kind: 'ongoing' }
  }
  const s = useSessionStore.getState()
  if (p.groupView !== null) {
    const group = s.groups.find((g) => g.id === p.groupView)
    return { label: group?.name ?? 'Group page', kind: 'group-page' }
  }
  if (p.tabView !== null) {
    const session = s.sessions.find((x) => x.id === p.tabView)
    const page = session?.view ? session.view.title || hostOf(session.view.url) : null
    const name = session?.name ?? 'Tab'
    return { label: page ? `${name} · ${page}` : name, kind: 'tab-page' }
  }
  const named = p.tabs.flatMap((id) => {
    const name = tabName(s, id)
    return name === null ? [] : [{ id, name }]
  })
  const lead = named.find((tab) => tab.id === p.focused) ?? named[0]
  if (!lead) return { label: p.tabs.length > 1 ? 'Tabs' : 'Tab', kind: 'tab' }
  if (named.length > 1) return { label: `${lead.name} + ${named.length - 1}`, kind: 'tabs' }
  const card = p.beside?.[lead.id] ?? null
  if (card) return { label: `${lead.name} · ${cardTitle(lead.id, card)}`, kind: card.kind }
  return { label: lead.name, kind: isFileTabId(lead.id) ? 'file' : 'tab' }
}

/** How a place is named in the lists behind Back and Forward, from the stores as they are
 *  now, with the workspace's name when it is not the one on screen. */
export function placeLabel(p: Place): { label: string; kind: PlaceKind } {
  const { label, kind } = describePlace(p)
  const workspaces = useWorkspaceStore.getState()
  if (p.workspaceId === null || p.workspaceId === workspaces.activeWorkspaceId) {
    return { label, kind }
  }
  const name = findWorkspace(workspaces, p.workspaceId)?.name
  return { label: name ? `${label} · ${name}` : label, kind }
}
