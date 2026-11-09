/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node and imported by a vitest */
// The native phones' design tokens, read from the desktop's own token file
// (packages/ui/src/tokens.css) rather than restated by hand. Two readings:
//
// - the colour roles, as apps/mobile's prototype reads them: the four theme
//   blocks (dark on :root, light, coffee, charcoal) and the cross-theme roles
//   of the @theme block, each normalised to a lowercase hex or an
//   `rgba(r, g, b, a)` both Swift and Kotlin parse;
// - the spec numbers (the control, the frame, the radius scale, the control
//   heights, the sidebar row), evaluated to pixels from the @theme block at
//   the Compact preset with Appearance → Text size at zero.
//
// Only literal values cross: a value that names something this file cannot
// evaluate throws, named, so a stylesheet change the phones cannot follow
// fails the generator instead of shipping a wrong number.

export const THEME_NAMES = ['dark', 'light', 'coffee', 'charcoal']

/** The per-theme roles, phone name → desktop custom property. */
export const THEME_ROLES = {
  surface0: 'surface-0',
  surface50: 'surface-50',
  surface100: 'surface-100',
  surface200: 'surface-200',
  surface300: 'surface-300',
  surface400: 'surface-400',
  surfaceRaised: 'surface-raised',
  border: 'border-color',
  borderSubtle: 'border-subtle-color',
  textPrimary: 'text-primary',
  textSecondary: 'text-secondary',
  textTertiary: 'text-tertiary',
  accent: 'accent',
  accentHover: 'accent-hover',
  action: 'action',
  actionHover: 'action-hover',
  actionForeground: 'action-foreground',
  sidebarItemText: 'sidebar-item-text',
  sidebarIconColor: 'sidebar-icon-color',
  selectedRing: 'selected-ring',
  scrim: 'scrim-color',
  gitWorktree: 'git-worktree'
}

/** The roles every theme shares, from the @theme block. */
export const SHARED_ROLES = {
  destructive: 'color-destructive',
  success: 'color-success',
  warning: 'color-warning',
  statusWorking: 'color-status-working',
  statusReady: 'color-status-ready',
  statusWaiting: 'color-status-waiting',
  statusInactive: 'color-status-inactive',
  switchKnob: 'color-switch-knob',
  brandClaude: 'brand-claude',
  gitModified: 'color-git-modified',
  gitIncoming: 'color-git-incoming',
  termCwd: 'color-term-cwd',
  termModel: 'color-term-model',
  termMode: 'color-term-mode'
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every top-level `selector { declarations }` block of a flat stylesheet. */
function blocks(css) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] })
  return out
}

function declarations(body) {
  const map = new Map()
  for (const line of body.split(';')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const name = line.slice(0, i).trim()
    if (!name.startsWith('--')) continue
    map.set(name.slice(2), line.slice(i + 1).trim())
  }
  return map
}

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const toHex2 = (x) =>
  Math.round(clamp01(x) * 255)
    .toString(16)
    .padStart(2, '0')

/** oklch → sRGB hex (the CSS Color 4 math, clipped to the gamut). */
export function oklchToHex(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const gamma = (c) => {
    const v = clamp01(c)
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  }
  return `#${toHex2(gamma(r))}${toHex2(gamma(g))}${toHex2(gamma(bl))}`
}

const num = (s) => Number.parseFloat(s)

/** A CSS colour literal as the phone's parser reads it: hex and comma rgba
 *  pass, space-separated rgb and oklch are rewritten. Anything else (a var,
 *  a color-mix) is refused: the phone derives those itself. */
export function normalizeColor(value, name) {
  const v = value.trim()
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v.toLowerCase()
  let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v)
  if (m)
    return `rgba(${num(m[1])}, ${num(m[2])}, ${num(m[3])}, ${m[4] === undefined ? 1 : num(m[4])})`
  m = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(v)
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? num(m[4]) / 100 : num(m[4])
    return `rgba(${num(m[1])}, ${num(m[2])}, ${num(m[3])}, ${alpha})`
  }
  m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(v)
  if (m) {
    const L = m[1].endsWith('%') ? num(m[1]) / 100 : num(m[1])
    return oklchToHex(L, num(m[2]), num(m[3]))
  }
  throw new Error(`tokens.css: --${name} is not a colour literal the phone can read: ${v}`)
}

/** The themes and the shared roles, read out of the stylesheet. */
export function tokensFromCss(css) {
  const flat = stripComments(css)
  const all = blocks(flat)
  const themeBlock = all.find((b) => b.selector === '@theme')
  if (!themeBlock) throw new Error('tokens.css: no @theme block')
  const shared = declarations(themeBlock.body)
  const themes = {}
  for (const theme of THEME_NAMES) {
    const block = all.find((b) =>
      theme === 'dark'
        ? b.selector.includes(':root') && b.selector.includes('[data-theme="dark"]')
        : b.selector === `[data-theme="${theme}"]`
    )
    if (!block) throw new Error(`tokens.css: no block for the ${theme} theme`)
    const decls = declarations(block.body)
    const colors = {}
    for (const [key, prop] of Object.entries(THEME_ROLES)) {
      const value = decls.get(prop)
      if (value === undefined) throw new Error(`tokens.css: the ${theme} theme has no --${prop}`)
      colors[key] = normalizeColor(value, prop)
    }
    const rgb = decls.get('rule-rgb')
    const alpha = decls.get('rule-alpha')
    if (!rgb || !alpha) throw new Error(`tokens.css: the ${theme} theme has no rule hairline`)
    const [r, g, b] = rgb.split(/\s+/).map(num)
    colors.rule = `rgba(${r}, ${g}, ${b}, ${num(alpha)})`
    themes[theme] = colors
  }
  const sharedColors = {}
  for (const [key, prop] of Object.entries(SHARED_ROLES)) {
    const value = shared.get(prop)
    if (value === undefined) throw new Error(`tokens.css: @theme has no --${prop}`)
    sharedColors[key] = normalizeColor(value, prop)
  }
  const weight = shared.get('font-weight-medium')
  if (!weight) throw new Error('tokens.css: @theme has no --font-weight-medium')
  return { themes, shared: sharedColors, fontWeightMedium: Number.parseInt(weight, 10) }
}

/** The @theme block's declarations, comments stripped. */
function themeDeclarations(css) {
  const block = blocks(stripComments(css)).find((b) => b.selector === '@theme')
  if (!block) throw new Error('tokens.css: no @theme block')
  return declarations(block.body)
}

/** Every value fixed rather than read: Appearance → Text size adds nothing. */
const FIXED = { 'ui-text-offset': 0 }

const REM = 16

/** One CSS length expression → px. Supports literals (px, rem, unitless),
 *  var(--name) and calc() with + - * and parentheses. */
function evaluate(value, name, decls, seen) {
  const fail = () => {
    throw new Error(`tokens.css: --${name} cannot be resolved to a number: ${value}`)
  }
  const tokens = []
  const re = /\s*(?:(\d*\.?\d+)(px|rem)?|var\(\s*--([\w-]+)\s*\)|(calc\()|([()+\-*]))/y
  let i = 0
  const src = value.trim()
  while (i < src.length) {
    re.lastIndex = i
    const m = re.exec(src)
    if (!m) fail()
    i = re.lastIndex
    if (m[1] !== undefined) {
      const n = Number.parseFloat(m[1])
      tokens.push({ kind: 'num', value: m[2] === 'rem' ? n * REM : n, unit: m[2] !== undefined })
    } else if (m[3] !== undefined) {
      tokens.push({ kind: 'num', value: resolve(m[3], decls, seen), unit: true })
    } else if (m[4] !== undefined) tokens.push({ kind: '(' })
    else tokens.push({ kind: m[5] })
    while (i < src.length && /\s/.test(src[i])) i++
  }
  let pos = 0
  const peek = () => tokens[pos]
  const primary = () => {
    const t = tokens[pos++]
    if (!t) fail()
    if (t.kind === 'num') return { value: t.value, unit: t.unit }
    if (t.kind === '(') {
      const inner = sum()
      if (tokens[pos++]?.kind !== ')') fail()
      return inner
    }
    if (t.kind === '-') {
      const v = primary()
      return { value: -v.value, unit: v.unit }
    }
    return fail()
  }
  const product = () => {
    let left = primary()
    while (peek()?.kind === '*') {
      pos++
      const right = primary()
      if (left.unit && right.unit) fail()
      left = { value: left.value * right.value, unit: left.unit || right.unit }
    }
    return left
  }
  const sum = () => {
    let left = product()
    while (peek()?.kind === '+' || peek()?.kind === '-') {
      const op = tokens[pos++].kind
      const right = product()
      left = { value: op === '+' ? left.value + right.value : left.value - right.value, unit: true }
    }
    return left
  }
  if (!tokens.length) fail()
  const result = sum()
  if (pos !== tokens.length) fail()
  return result.value
}

function resolve(name, decls, seen = new Set()) {
  if (name in FIXED) return FIXED[name]
  const value = decls.get(name)
  if (value === undefined) throw new Error(`tokens.css: @theme has no --${name}`)
  if (seen.has(name)) throw new Error(`tokens.css: --${name} refers to itself`)
  const next = new Set(seen).add(name)
  return evaluate(value, name, decls, next)
}

/** The spec groups, phone name → desktop custom property. */
export const SPEC = {
  control: {
    height: 'control-h',
    paddingX: 'control-px',
    gap: 'control-gap',
    text: 'control-text',
    textSmall: 'control-text-sm',
    radius: 'control-radius',
    icon: 'control-icon'
  },
  frame: {
    border: 'frame-border',
    inset: 'frame-inset',
    height: 'frame-h',
    radius: 'frame-radius',
    controlHeight: 'framed-control-h',
    controlRadius: 'framed-control-radius',
    controlIcon: 'framed-control-icon',
    surfaceInset: 'surface-inset'
  },
  radius: {
    sm: 'radius-sm',
    md: 'radius-md',
    lg: 'radius-lg',
    xl: 'radius-xl',
    '2xl': 'radius-2xl',
    full: 'radius-full'
  },
  controlHeights: {
    xs: 'control-h-xs',
    sm: 'control-h-sm',
    md: 'control-h-md',
    lg: 'control-h-lg'
  },
  sidebar: {
    rowHeight: 'sidebar-row-h',
    rowGap: 'row-gap',
    iconSize: 'sidebar-tab-icon-size',
    rowPaddingX: 'sidebar-row-px'
  }
}

/** The spec numbers of the @theme block, in px. */
export function specFromCss(css) {
  const decls = themeDeclarations(css)
  const out = {}
  for (const [group, roles] of Object.entries(SPEC)) {
    out[group] = {}
    for (const [key, prop] of Object.entries(roles)) out[group][key] = resolve(prop, decls)
  }
  return out
}

/** The first family of --font-sans, unquoted. */
export function fontSansFromCss(css) {
  const value = themeDeclarations(css).get('font-sans')
  if (!value) throw new Error('tokens.css: @theme has no --font-sans')
  return value
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
}
