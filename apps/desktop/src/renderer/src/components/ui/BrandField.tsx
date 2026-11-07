import { useEffect, useRef } from 'react'
import { useSessionStore } from '../../store/session-store'
import { useSkinStore } from '../../lib/skin'
import { paintField, type PaletteKey } from '../../lib/brand-field'

/**
 * A canvas painted with one Antasphere field — gradient, optional veil, film
 * grain. Sizes itself to whatever box it is put in and repaints on resize, so
 * the caller only ever sets CSS dimensions.
 *
 * `groundLift` is how a field is quietened: how far off the app's own surface
 * the finished ground may sit, in luminance. A wash of that surface is laid
 * over the gradient BEFORE the grain — solved, not fixed, so Basalt and
 * Glacier land at the same value and differ only in hue — and the noise then
 * arrives at full strength. Never fade this canvas with CSS opacity to the
 * same end: that fades the grain too, and a field without its grain is a grey
 * smear. The surface is read from `--surface-0` at paint time, which is why
 * the component watches the theme: the wash has to follow the app.
 *
 * Still by construction: the console animates its fields on a drift clock, and
 * a drifting gradient at the foot of a sidebar you look at all day is a
 * distraction rather than a signature.
 */
export function BrandField({
  palette,
  seed,
  groundLift = 0,
  grainAlpha,
  className,
  style
}: {
  palette: PaletteKey
  seed: number
  groundLift?: number
  grainAlpha?: number
  className?: string
  style?: React.CSSProperties
}): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null)
  // Not read directly — they are the repaint triggers. A theme flip changes the
  // ground the veil is made of, and nothing else would tell this canvas. The
  // theme NAME alone is not enough: at launch it is already restored from
  // localStorage, so the first paint reads --surface-0 before the skin's tokens
  // land, and the skin's arrival then leaves the name unchanged. The skin
  // revision moves every time tokens are applied, which is the moment that
  // counts.
  const theme = useSessionStore((s) => s.theme)
  const skinRevision = useSkinStore((s) => s.revision)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = (): void => {
      const r = canvas.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const W = Math.round(r.width * dpr)
      const H = Math.round(r.height * dpr)
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const groundColor =
        groundLift > 0
          ? getComputedStyle(canvas).getPropertyValue('--surface-0').trim() || '#000'
          : undefined
      paintField(ctx, W, H, palette, seed, dpr, { groundLift, groundColor, grainAlpha })
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [palette, seed, groundLift, grainAlpha, theme, skinRevision])

  return <canvas ref={ref} className={className} style={style} aria-hidden="true" />
}
