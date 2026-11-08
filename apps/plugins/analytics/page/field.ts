import {
  PALETTE_KEYS,
  paintField,
  seedFromString,
  type PaletteKey
} from '../../../desktop/src/renderer/src/lib/brand-field'

/**
 * The brand field as the workspace home's ground: the app's own engine (the renderer's
 * `lib/brand-field.ts`, imported rather than copied so the house's palettes stay one table),
 * painted on a canvas that fills its host and lifted toward the page's own surface with the
 * engine's `groundLift`, never with opacity, so the grain stays and only the colour is
 * quietened. The palette is one of the house's twelve, chosen by the workspace id, so a
 * workspace keeps its field from one open to the next.
 */

const DEFAULT_LIFT = 0.06
const SURFACE_POLL_MS = 1_000

/** Any CSS colour as `#rrggbb`, through a one-pixel canvas; null when the page has no canvas. */
export function toHex(color: string): string | null {
  const probe = document.createElement('canvas')
  probe.width = probe.height = 1
  const ctx = probe.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#000000'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`
}

/** The house palette a workspace wears, stable for its id. */
export function paletteFor(id: string): PaletteKey {
  return PALETTE_KEYS[seedFromString(id) % PALETTE_KEYS.length]!
}

export interface Ground {
  repaint(): void
  destroy(): void
}

/** The page's surface token as painted now. */
function surfaceColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim() || '#000'
}

/**
 * Paints the field on `canvas` across `host`, and paints it again when the host is resized
 * or when the page's surface changes (the app inserts its live theme tokens into the page,
 * which no DOM event announces, so the surface is read once a second and compared).
 */
export function mountGround(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  id: string,
  lift = DEFAULT_LIFT
): Ground {
  const palette = paletteFor(id)
  const seed = seedFromString(id)
  let painted = ''
  const repaint = (): void => {
    const rect = host.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const W = Math.round(rect.width * dpr)
    const H = Math.round(rect.height * dpr)
    const surface = surfaceColor()
    const key = `${W}x${H}:${surface}`
    if (key === painted) return
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    paintField(ctx, W, H, palette, seed, dpr, {
      groundLift: lift,
      groundColor: toHex(surface) ?? '#000000'
    })
    painted = key
  }
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => repaint())
  observer?.observe(host)
  const poll = setInterval(repaint, SURFACE_POLL_MS)
  repaint()
  return {
    repaint,
    destroy(): void {
      observer?.disconnect()
      clearInterval(poll)
    }
  }
}
