/**
 * The tab each routine's panel was left on (6 November 2026, Romain: "I
 * don't want to go back to Report every time if I just sent a message").
 * Kept per routine in localStorage, so it holds across the panel's closes and
 * the app's restarts; a value that is not a tab reads as Report.
 */
export type PanelTab = 'report' | 'discussion' | 'runs'

const KEY = 'clave.routines.panelTab'
const TABS: ReadonlySet<string> = new Set(['report', 'discussion', 'runs'])

function readAll(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function rememberedTab(routineKey: string): PanelTab {
  const tab = readAll()[routineKey]
  return tab && TABS.has(tab) ? (tab as PanelTab) : 'report'
}

export function rememberTab(routineKey: string, tab: PanelTab): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...readAll(), [routineKey]: tab }))
  } catch {
    /* storage full or unavailable: the panel simply opens on Report next time */
  }
}
