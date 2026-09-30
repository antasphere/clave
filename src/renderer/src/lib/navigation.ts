import { useSessionStore } from '../store/session-store'
import type { ActiveView } from '../store/session-types'

const VIEW_TARGETS: Set<string> = new Set(['terminals', 'settings', 'agents', 'extensions'])

const SIDE_PANEL_TABS: Record<string, 'files' | 'git' | 'help'> = {
  'side:files': 'files',
  'side:git': 'git',
  'side:help': 'help'
}

export function navigateTo(target: string): boolean {
  const store = useSessionStore.getState()

  // Settings panes addressed by name. `usage` predates the settings move and
  // is kept working; `updates` is how the release note points at the new
  // Software Update pane.
  if (target === 'usage' || target === 'updates') {
    store.openSettings(target)
    return true
  }

  if (VIEW_TARGETS.has(target)) {
    store.setActiveView(target as ActiveView)
    return true
  }

  const sideTab = SIDE_PANEL_TABS[target]
  if (sideTab) {
    if (!store.fileTreeOpen) {
      store.toggleFileTree()
    }
    store.setSidePanelTab(sideTab)
    return true
  }

  return false
}

export function handleClaveLink(href: string): boolean {
  if (!href.startsWith('clave://navigate/')) return false
  const target = href.replace('clave://navigate/', '')
  return navigateTo(target)
}
