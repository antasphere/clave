/**
 * The Antasphere generative field, ported into Clave.
 *
 * A field is a base coat, a handful of drifting radial blobs blurred into each
 * other, and one pass of film grain over the top. It is the house's own
 * material — the same construction the antasphere.com pages sit on and the
 * brand console declares — and it arrives here for exactly one job: the thing
 * that stands for *you* at the foot of the sidebar.
 *
 * Faithful port of `company/website/apps/website/src/brand/engine.ts`, itself a
 * port of the console's `src/lib/engine/engine.js` (buildBlobs, renderLow, the
 * film pass). The numbers are the console's, unchanged; only the plumbing is
 * ours. The console's linework plates are NOT ported: at 28px a construction is
 * a smudge, and what reads at this size is colour and grain.
 *
 * ⚠️ These tables are mirrored, not owned. When the console's PALETTES or its
 * grain constant change, change them here too.
 */

export const TAU = Math.PI * 2

/** The grain constant: film, 0.22 at 1:1, identical on every Antasphere surface. */
export const GRAIN = { alpha: 0.22, size: 1.0 }

/** Width of the low-resolution render the blobs are laid down on. */
const LOW_W = 116

export interface Palette {
  /** A light ground: the film pass overlays, and ink over it is near-black. */
  light: boolean
  base: string
  hues: readonly string[]
  /**
   * The one hue that stands for the field — its signature, always a member of
   * `hues` rather than a colour invented beside them. It is what a surface
   * made of this field lights its controls up in: over a coloured ground the
   * app's grey hover reads as dirt on the picture, not as a control waking.
   * Chosen as the palette's most characteristic MID-tone, so a wash of it
   * lands on both a dark and a light app theme.
   */
  accent: string
}

/**
 * The console's ten themes. `light` flips both the film pass's composite and
 * the ink an icon is knocked out in, so it is a property of the field rather
 * than of the app's theme — a Glacier tile stays a bright window whatever
 * Clave is wearing.
 */
export const PALETTES: Record<string, Palette> = {
  glacier: {
    light: true,
    base: '#E9F0F3',
    hues: ['#F8FBFC', '#DEEAF0', '#C6DAE5', '#A3C4D6', '#7FA9C2', '#EBF3EF', '#5D8CA9'],
    accent: '#5D8CA9'
  },
  tide: {
    light: false,
    base: '#3A4A52',
    hues: ['#2B3A42', '#5C7285', '#7FA3A8', '#4A6355', '#C2CCC7', '#8FA8B8', '#33413B'],
    accent: '#7FA3A8'
  },
  furnace: {
    light: false,
    base: '#33261E',
    hues: ['#4A6B66', '#2E4744', '#E89B4F', '#C25C2E', '#8A3A24', '#1F1712', '#E8C088'],
    accent: '#E89B4F'
  },
  meadow: {
    light: false,
    base: '#22331C',
    hues: ['#16240F', '#3E5C26', '#6E8C33', '#D9A03F', '#7FA8C9', '#E4D9BC', '#C9803F'],
    accent: '#6E8C33'
  },
  aurora: {
    light: false,
    base: '#221B33',
    hues: ['#150F22', '#3A2A63', '#6C4FA8', '#B06BC4', '#4FD0C0', '#8FE3B8', '#E5C0F0'],
    accent: '#B06BC4'
  },
  basalt: {
    light: false,
    base: '#26282B',
    hues: ['#17181A', '#33373B', '#4E555C', '#6B737A', '#8C949B', '#2A3138', '#C0C4C6'],
    accent: '#8C949B'
  },
  verdigris: {
    light: false,
    base: '#1F3A35',
    hues: ['#132724', '#152825', '#2C5F55', '#3E8C7A', '#7FC2AC', '#C9A227', '#0F1D1B'],
    accent: '#3E8C7A'
  },
  solar: {
    light: true,
    base: '#F2E4C9',
    hues: ['#FFF6E4', '#FBE9C4', '#F3C77E', '#E8A04F', '#F5DDB0', '#FFFDF6', '#DE8B4A'],
    accent: '#E8A04F'
  },
  dawn: {
    light: true,
    base: '#F6E9DE',
    hues: ['#FDF5EC', '#F9DFC9', '#F3C7AC', '#EBA284', '#DB7D5F', '#F3D6E0', '#C9664A'],
    accent: '#DB7D5F'
  },
  reef: {
    light: true,
    base: '#E5F1EB',
    hues: ['#F5FBF8', '#D4EAE0', '#B0DCCE', '#82C4B0', '#4FAB92', '#F2C9AE', '#2F8E78'],
    accent: '#4FAB92'
  },
  iris: {
    light: true,
    base: '#EAEBF7',
    hues: ['#F8F8FD', '#DEE0F4', '#C5C9EC', '#A2A8DE', '#7E86CE', '#E9DDF1', '#5A63BA'],
    accent: '#7E86CE'
  },
  pearl: {
    light: true,
    base: '#F0EDEE',
    hues: ['#FBF9F9', '#E9E2F2', '#DFEBE6', '#F5E3E4', '#C9BBDF', '#AFCFC6', '#8E7CB8'],
    accent: '#8E7CB8'
  }
}

export type PaletteKey = keyof typeof PALETTES

/** Display order — the picker reads left to right in this order. */
export const PALETTE_KEYS = [
  'glacier',
  'tide',
  'verdigris',
  'meadow',
  'furnace',
  'aurora',
  'basalt',
  'iris',
  'reef',
  'dawn',
  'solar',
  'pearl'
] as const satisfies readonly PaletteKey[]

/** Human names, for the picker's tooltips. */
export const PALETTE_LABELS: Record<PaletteKey, string> = {
  glacier: 'Glacier',
  tide: 'Tide',
  furnace: 'Furnace',
  meadow: 'Meadow',
  aurora: 'Aurora',
  basalt: 'Basalt',
  verdigris: 'Verdigris',
  solar: 'Solar',
  dawn: 'Dawn',
  reef: 'Reef',
  iris: 'Iris',
  pearl: 'Pearl'
}

export function isPaletteKey(v: unknown): v is PaletteKey {
  return typeof v === 'string' && v in PALETTES
}

/** The ink a field is legible in: near-black on a light ground, creme on a dark one. */
export function fieldInk(key: PaletteKey): string {
  return PALETTES[key].light ? '#1C1915' : '#F7F4EC'
}

/** The field's signature hue — what a surface made of this field lights its
 *  controls up in. See `Palette.accent`. */
export function fieldAccent(key: PaletteKey): string {
  return PALETTES[key].accent
}

/** The engine's seeded PRNG, verbatim: same seed, same field, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FieldBlob {
  color: string
  x: number
  y: number
  r: number
  alpha: number
}

/** The blobs a seed lays down in a palette. The drift parameters the console
 *  animates with are dropped: a still field is what an avatar wants. */
export function buildBlobs(seed: number, key: PaletteKey): FieldBlob[] {
  const pal = PALETTES[key]
  const rnd = mulberry32(seed)
  const count = 7 + Math.floor(rnd() * 4)
  const blobs: FieldBlob[] = []
  for (let i = 0; i < count; i++) {
    blobs.push({
      color: pal.hues[Math.floor(rnd() * pal.hues.length)],
      x: rnd(),
      y: rnd(),
      r: 0.22 + rnd() * 0.4,
      alpha: 0.75 + rnd() * 0.25
    })
  }
  return blobs
}

/** One film-grain tile, built once and shared: it is pure noise, so every
 *  surface can pattern off the same 512² square. */
let grainTile: HTMLCanvasElement | null = null
function getGrainTile(): HTMLCanvasElement {
  if (grainTile) return grainTile
  const size = 512
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255 * 0.9
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  grainTile = c
  return c
}

/** The low-resolution field: base coat plus the blobs, ready to be blurred up. */
function renderLow(blobs: FieldBlob[], key: PaletteKey, W: number, H: number): HTMLCanvasElement {
  const pal = PALETTES[key]
  const lw = LOW_W
  const lh = Math.max(8, Math.round((LOW_W * H) / W))
  const low = document.createElement('canvas')
  low.width = lw
  low.height = lh
  const lc = low.getContext('2d')!
  lc.fillStyle = pal.base
  lc.fillRect(0, 0, lw, lh)
  for (const b of blobs) {
    const x = b.x * lw
    const y = b.y * lh
    const r = b.r * lw
    const g = lc.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, b.color)
    g.addColorStop(1, b.color.slice(0, 7) + '00')
    lc.fillStyle = g
    lc.globalAlpha = b.alpha
    lc.beginPath()
    lc.arc(x, y, r, 0, TAU)
    lc.fill()
    lc.globalAlpha = 1
  }
  return low
}

/**
 * Paint one field across the whole of `ctx` at W×H device pixels.
 *
 * Three passes, in this order, and the order is the whole point:
 *
 *  1. The gradient, composed at a WORKING resolution of at least `MIN_WORK`
 *     and scaled down. The blur radius is a fraction of the width, so on a
 *     64px avatar it would be 4px — a quarter of the tile — and every palette
 *     collapsed into the same brown-grey mush. Composing large and shrinking
 *     keeps the pooled hues a 32px tile is chosen for.
 *  2. `veil`, a wash of the surrounding ground laid OVER the gradient. This is
 *     how a field is quietened, and it is deliberately not CSS opacity: fading
 *     the finished canvas fades the grain with it, and what is left is a grey
 *     smear. Veiling pulls only the COLOUR toward the app's own ground and
 *     leaves the next pass at full strength — the website's ground reads the
 *     way it does because the gradient is barely there and the noise is loud,
 *     not because the whole picture is turned down.
 *  3. The film. Overlay is the right op on a light ground, but its dark arm is
 *     a multiply, so on a dark field the noise collapses into the ground and
 *     the film disappears: those take the same tile through `screen` instead,
 *     at half the alpha because screen moves the ground where overlay only
 *     modulates it. (The website's own correction — keep the two in step.)
 *
 * Grain always lands last and at the target size, or the resampling in pass 1
 * would average it away.
 */
const MIN_WORK = 320

/** sRGB luminance of a #rgb/#rrggbb colour, 0–1. Returns null for anything else
 *  — the caller then falls back to the palette's own `light` flag. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Mean sRGB luminance of a canvas, 0–1. */
function meanLuminance(c: HTMLCanvasElement): number {
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) {
    sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  }
  return sum / (d.length / 4) / 255
}

function hexLuminance(css: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim())
  if (!m) return null
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  const n = parseInt(h, 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

export interface FieldOptions {
  /**
   * How far the finished ground may sit off the app's own surface, in
   * luminance (0–1). This is the knob, not a veil alpha: the twelve palettes
   * run from near-black Basalt to near-white Glacier, and one fixed alpha
   * either leaves the dark ones invisible or turns the pale ones into a lamp.
   * The alpha is SOLVED from the field's measured luminance so every palette
   * lands the same distance off the ground and differs only in hue.
   *
   * Omit it (or pass 0) for a raw field at full strength — what an avatar
   * tile wants, since there it IS the picture.
   */
  groundLift?: number
  /** The app's own surface, a #hex. Required for groundLift to do anything. */
  groundColor?: string
  /** Override the film pass. Defaults to the house constant. */
  grainAlpha?: number
}

export function paintField(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  key: PaletteKey,
  seed: number,
  dpr: number,
  opts: FieldOptions = {}
): void {
  const scale = Math.max(1, MIN_WORK / W)
  const RW = Math.round(W * scale)
  const RH = Math.max(2, Math.round(H * scale))

  const low = renderLow(buildBlobs(seed, key), key, RW, RH)

  const work = document.createElement('canvas')
  work.width = RW
  work.height = RH
  const wc = work.getContext('2d')!
  wc.imageSmoothingEnabled = true
  wc.imageSmoothingQuality = 'high'
  wc.filter = 'blur(' + Math.max(4, Math.round(RW * 0.018)) + 'px)'
  wc.drawImage(low, -RW * 0.06, -RH * 0.06, RW * 1.12, RH * 1.12)
  wc.filter = 'none'

  ctx.clearRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(work, 0, 0, W, H)

  /* Solve the veil rather than take one. `low` is the same picture as `work`
     before the blur — a 116px-wide render — so it is the cheap place to
     measure the field's mean luminance, and blurring does not move a mean. */
  const lift = opts.groundLift ?? 0
  const groundLum = opts.groundColor ? hexLuminance(opts.groundColor) : null
  let veiled: number | null = null
  if (lift > 0 && opts.groundColor && groundLum !== null) {
    const fieldLum = meanLuminance(low)
    // Lift AWAY from the ground: up from a dark app, down from a pale one.
    const target = groundLum < 0.5 ? groundLum + lift : groundLum - lift
    const spread = fieldLum - groundLum
    // A field already at the ground's own value needs no veil at all.
    const alpha = Math.abs(spread) < 0.02 ? 0 : clamp01((fieldLum - target) / spread)
    if (alpha > 0) {
      ctx.globalAlpha = alpha
      ctx.fillStyle = opts.groundColor
      ctx.fillRect(0, 0, W, H)
      ctx.globalAlpha = 1
    }
    veiled = groundLum
  }

  /* Which arm of the film pass to take is a property of the ground the grain
     actually lands on, not of the palette. Once a field is veiled back to the
     app's surface, the palette's own `light` flag describes a picture that is
     no longer there — a pale palette veiled onto a dark app took the LIGHT arm
     and lifted the whole panel into grey smoke. */
  const onDark = veiled === null ? !PALETTES[key].light : veiled < 0.5
  const base = opts.grainAlpha ?? GRAIN.alpha
  ctx.globalCompositeOperation = onDark ? 'screen' : 'overlay'
  ctx.globalAlpha = onDark ? base * 0.5 : base
  const pattern = ctx.createPattern(getGrainTile(), 'repeat')!
  pattern.setTransform(new DOMMatrix().scale(GRAIN.size * dpr))
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}

/** A stable seed from a string — so a name always draws the same field until
 *  its owner rerolls it. FNV-1a, kept to 31 bits for mulberry32. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 0x7fffffff
}
