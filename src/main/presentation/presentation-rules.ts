/**
 * The rules of a presentation window (PRDCT-4980): which display a deck is
 * presented on, which address main agrees to show, where its page may go and
 * which key ends it. No Electron here, so each rule is tested alone
 * (`presentation-rules.test.ts`); `presentation-windows.ts` applies them.
 */

export interface DisplayLike {
  readonly id: number
}

/**
 * The display a deck is presented on: another display than the one the
 * Clave window is on (a projector, a second screen), else that one. Null
 * when the screen lists none.
 */
export function pickDisplay<D extends DisplayLike>(
  displays: readonly D[],
  ownerDisplayId: number | null
): D | null {
  return (
    displays.find((d) => d.id !== ownerDisplayId) ??
    displays.find((d) => d.id === ownerDisplayId) ??
    null
  )
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
