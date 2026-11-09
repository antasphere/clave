#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The iPhone app's colour roles, read from the desktop's own token file
// (packages/ui/src/tokens.css) rather than restated by hand, so a token the
// desktop changes cannot drift silently on the phone. A port of the React
// Native prototype's apps/mobile/scripts/tokens-from-css.mjs and
// generate-tokens.mjs, kept self-contained so the native app does not depend
// on the prototype's folder.
//
// Only literal values cross: a hex, an rgb/rgba, an oklch (converted to sRGB
// and rounded to 8 bits per channel, exactly as the prototype does, so both
// phones paint the same bytes), and the rule hairline composed from its rgb
// and alpha. A value naming another token (color-mix, var()) stays the
// desktop's; Theme.swift derives what it needs from the roles below.
//
//   node scripts/generate-tokens.mjs           writes Clave/Theme/Tokens.generated.swift
//   node scripts/generate-tokens.mjs --check   exits 1 when the committed file is stale
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOKENS_CSS = path.resolve(here, '..', '..', '..', 'packages', 'ui', 'src', 'tokens.css')
const GENERATED = path.resolve(here, '..', 'Clave', 'Theme', 'Tokens.generated.swift')

const THEME_NAMES = ['dark', 'light', 'coffee', 'charcoal']

/** The per-theme roles, Swift name -> desktop custom property. */
const THEME_ROLES = {
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
const SHARED_ROLES = {
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
const to8 = (x) => Math.round(clamp01(x) * 255)
const num = (s) => Number.parseFloat(s)

/** oklch -> sRGB bytes (the CSS Color 4 math, clipped to the gamut). */
function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const gamma = (c) => {
    const v = clamp01(c)
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
  }
  return [to8(gamma(r)), to8(gamma(g)), to8(gamma(bl))]
}

/** A CSS colour literal as { rgb bytes, alpha, source }. Anything else (a var,
 *  a color-mix) is refused: the app derives those itself. */
function parseColor(value, name) {
  const v = value.trim()
  let m = /^#([0-9a-f]{3,8})$/i.exec(v)
  if (m) {
    let hex = m[1].toLowerCase()
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('')
    if (hex.length !== 6 && hex.length !== 8)
      throw new Error(`tokens.css: --${name} has a malformed hex: ${v}`)
    const bytes = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
    const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { rgb: bytes, alpha, source: v.toLowerCase() }
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v)
  if (m)
    return {
      rgb: [num(m[1]), num(m[2]), num(m[3])],
      alpha: m[4] === undefined ? 1 : num(m[4]),
      source: v
    }
  m = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(v)
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? num(m[4]) / 100 : num(m[4])
    return { rgb: [num(m[1]), num(m[2]), num(m[3])], alpha, source: v }
  }
  m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(v)
  if (m) {
    const L = m[1].endsWith('%') ? num(m[1]) / 100 : num(m[1])
    return { rgb: oklchToRgb(L, num(m[2]), num(m[3])), alpha: 1, source: v }
  }
  throw new Error(`tokens.css: --${name} is not a colour literal the app can read: ${v}`)
}

function tokensFromCss(css) {
  const all = blocks(stripComments(css))
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
      colors[key] = parseColor(value, prop)
    }
    // --rule-color multiplies the alpha by a user setting the phone does not
    // have, so the hairline is composed at its default intensity of 1.
    const rgb = decls.get('rule-rgb')
    const alpha = decls.get('rule-alpha')
    if (!rgb || !alpha) throw new Error(`tokens.css: the ${theme} theme has no rule hairline`)
    const parts = rgb.split(/\s+/).map(num)
    colors.rule = {
      rgb: parts,
      alpha: num(alpha),
      source: `rgb(${parts.join(' ')} / ${num(alpha)})`
    }
    themes[theme] = colors
  }
  const sharedColors = {}
  for (const [key, prop] of Object.entries(SHARED_ROLES)) {
    const value = shared.get(prop)
    if (value === undefined) throw new Error(`tokens.css: @theme has no --${prop}`)
    sharedColors[key] = parseColor(value, prop)
  }
  const weight = shared.get('font-weight-medium')
  if (!weight) throw new Error('tokens.css: @theme has no --font-weight-medium')
  return { themes, shared: sharedColors, fontWeightMedium: Number.parseInt(weight, 10) }
}

const component = (x) => {
  const s = (Math.round(x * 1e6) / 1e6).toString()
  return s.includes('.') || s.includes('e') ? s : `${s}.0`
}
const swiftColor = (c) =>
  `TokenColor(red: ${component(c.rgb[0] / 255)}, green: ${component(c.rgb[1] / 255)}, blue: ${component(c.rgb[2] / 255)}, opacity: ${component(c.alpha)})`

function renderSwift(tokens) {
  const roleKeys = [...Object.keys(THEME_ROLES), 'rule']
  const sharedKeys = Object.keys(SHARED_ROLES)
  const L = []
  L.push(
    '// Generated from packages/ui/src/tokens.css by apps/mobile-ios/scripts/generate-tokens.mjs.'
  )
  L.push('// Do not edit: run `node scripts/generate-tokens.mjs` in apps/mobile-ios to rewrite it;')
  L.push(
    '// `node scripts/generate-tokens.mjs --check` fails when it no longer matches the stylesheet.'
  )
  L.push('')
  L.push('nonisolated public enum ThemeName: String, CaseIterable, Codable, Sendable {')
  L.push(`  case ${THEME_NAMES.join(', ')}`)
  L.push('}')
  L.push('')
  L.push('/// An sRGB colour, each component in 0...1.')
  L.push('nonisolated public struct TokenColor: Equatable, Sendable {')
  L.push('  public let red, green, blue, opacity: Double')
  L.push('}')
  L.push('')
  L.push('nonisolated public struct ThemeColors: Equatable, Sendable {')
  for (const key of roleKeys) L.push(`  public let ${key}: TokenColor`)
  L.push('}')
  L.push('')
  L.push('nonisolated public let themeColors: [ThemeName: ThemeColors] = [')
  THEME_NAMES.forEach((theme, ti) => {
    L.push(`  .${theme}: ThemeColors(`)
    roleKeys.forEach((key, i) => {
      const c = tokens.themes[theme][key]
      const comma = i < roleKeys.length - 1 ? ',' : ''
      L.push(`    ${key}: ${swiftColor(c)}${comma} // ${c.source}`)
    })
    L.push(`  )${ti < THEME_NAMES.length - 1 ? ',' : ''}`)
  })
  L.push(']')
  L.push('')
  L.push('nonisolated public struct SharedColors: Equatable, Sendable {')
  for (const key of sharedKeys) L.push(`  public let ${key}: TokenColor`)
  L.push('}')
  L.push('')
  L.push('nonisolated public let sharedColors = SharedColors(')
  sharedKeys.forEach((key, i) => {
    const c = tokens.shared[key]
    const comma = i < sharedKeys.length - 1 ? ',' : ''
    L.push(`  ${key}: ${swiftColor(c)}${comma} // ${c.source}`)
  })
  L.push(')')
  L.push('')
  L.push("/// The desktop's `font-medium`.")
  L.push(`nonisolated public let fontWeightMedium = ${tokens.fontWeightMedium}`)
  L.push('')
  return L.join('\n')
}

const source = renderSwift(tokensFromCss(readFileSync(TOKENS_CSS, 'utf8')))
const rel = path.relative(process.cwd(), GENERATED)
if (process.argv.includes('--check')) {
  let current = null
  try {
    current = readFileSync(GENERATED, 'utf8')
  } catch {
    // A missing file is stale too.
  }
  if (current !== source) {
    console.error(
      `${rel} is out of date with packages/ui/src/tokens.css; run node scripts/generate-tokens.mjs`
    )
    process.exit(1)
  }
  console.log(`${rel} matches packages/ui/src/tokens.css`)
} else {
  writeFileSync(GENERATED, source)
  console.log(`wrote ${rel} (${source.length} bytes)`)
}
