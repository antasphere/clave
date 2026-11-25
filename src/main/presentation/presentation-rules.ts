/**
 * The rules of a presentation window (PRDCT-4980): where its window opens,
 * which address main agrees to show, where its page may go and which key
 * ends it. No Electron here, so each rule is tested alone
 * (`presentation-rules.test.ts`); `presentation-windows.ts` applies them.
 */

export interface Area {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The deck's area in its window: 16:9, 1280 by 720 when the display has the room. */
const DECK_WIDTH = 1280
const DECK_RATIO = 16 / 9
/** The share of the display's work area the deck may take at most, either way. */
const ROOM = 0.8

/**
 * Where a presentation window opens on its display's work area (PRDCT-5167):
 * a window like any other, never the whole screen. The deck's area (the
 * window's content) is 16:9, 1280 by 720, smaller when four fifths of the
 * work area is, and centred on it.
 */
export function presentationBounds(area: Area): Area {
  const width = Math.round(Math.min(DECK_WIDTH, area.width * ROOM, area.height * ROOM * DECK_RATIO))
  const height = Math.round(width / DECK_RATIO)
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height
  }
}

/**
 * The address main shows in a presentation window, normalised, or null: a
 * preview is plain HTTP on this Mac's loopback with a port of its own (the
 * server's own preview, or the port this Mac forwards a server's on), never
 * a page anywhere else, and never with credentials in it.
 */
export function presentableUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
  if (url.port === '' || url.username !== '' || url.password !== '') return null
  return url.toString()
}

/** Whether the page may go to `target` inside the window: its own origin only. */
export function staysOnPreview(target: string, preview: string): boolean {
  try {
    return new URL(target).origin === new URL(preview).origin
  } catch {
    return false
  }
}

/** A link the page opens elsewhere goes to the browser: web addresses only. */
export const opensInBrowser = (target: string): boolean => /^https?:\/\//i.test(target)

/** The key that ends a presentation: Escape pressed, whatever frame has the focus. */
export const endsPresentation = (input: { type: string; key: string }): boolean =>
  input.type === 'keyDown' && input.key === 'Escape'

/** What the presentation's own session lets a deck do: go full screen and copy, nothing else. */
export const presentationPermits = (permission: string): boolean =>
  permission === 'fullscreen' || permission === 'clipboard-sanitized-write'
