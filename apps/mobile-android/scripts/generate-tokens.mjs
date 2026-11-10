#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The phone's colour roles, read from the desktop's own token file
// (packages/ui/src/tokens.css) and written as Kotlin (ui/src/main/kotlin/com/clave/ui/theme/Tokens.kt):
// the four theme blocks (dark on :root, light, coffee, charcoal), the cross-theme roles of
// the @theme block and the medium weight. Only literal values cross: a hex, an rgb/rgba,
// an oklch (converted to sRGB), the rule hairline composed from its rgb and alpha. A value
// that names another token stays the desktop's; the theme derives what it needs from the
// roles. The parity test in :ui (TokensParityTest) re-reads the same stylesheet in Kotlin
// and fails when the committed module no longer matches it.
// Run from the repository root: node apps/mobile-android/scripts/generate-tokens.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const TOKENS_CSS = path.join(repo, 'packages', 'ui', 'src', 'tokens.css')
const OUT = path.resolve(here, '..', 'ui', 'src', 'main', 'kotlin', 'com', 'clave', 'ui', 'theme', 'Tokens.kt')

export const THEME_NAMES = ['dark', 'light', 'coffee', 'charcoal']
export const THEME_ROLES = {
  surface0: 'surface-0', surface50: 'surface-50', surface100: 'surface-100', surface200: 'surface-200',
  surface300: 'surface-300', surface400: 'surface-400', surfaceRaised: 'surface-raised',
  border: 'border-color', borderSubtle: 'border-subtle-color',
  textPrimary: 'text-primary', textSecondary: 'text-secondary', textTertiary: 'text-tertiary',
  accent: 'accent', accentHover: 'accent-hover', action: 'action', actionHover: 'action-hover',
  actionForeground: 'action-foreground', sidebarItemText: 'sidebar-item-text',
  sidebarIconColor: 'sidebar-icon-color', selectedRing: 'selected-ring', scrim: 'scrim-color',
  gitWorktree: 'git-worktree'
}
export const SHARED_ROLES = {
  destructive: 'color-destructive', success: 'color-success', warning: 'color-warning',
  statusWorking: 'color-status-working', statusReady: 'color-status-ready',
  statusWaiting: 'color-status-waiting', statusInactive: 'color-status-inactive',
  switchKnob: 'color-switch-knob', brandClaude: 'brand-claude', gitModified: 'color-git-modified',
  gitIncoming: 'color-git-incoming', termCwd: 'color-term-cwd', termModel: 'color-term-model',
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
const to255 = (x) => Math.round(clamp01(x) * 255)
export function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const gamma = (c) => { const v = clamp01(c); return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055 }
  return [to255(gamma(r)), to255(gamma(g)), to255(gamma(bl)), 255]
}
const num = (s) => Number.parseFloat(s)
/** A CSS colour literal as [r, g, b, a255]. */
export function parseColor(value, name) {
  const v = value.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(v)
  if (m) { const n = Number.parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255] }
  m = /^#([0-9a-f]{3})$/i.exec(v)
  if (m) return [...m[1]].map((c) => Number.parseInt(c + c, 16)).concat([255])
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v)
  if (m) return [num(m[1]), num(m[2]), num(m[3]), m[4] === undefined ? 255 : to255(num(m[4]))]
  m = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(v)
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? num(m[4]) / 100 : num(m[4])
    return [num(m[1]), num(m[2]), num(m[3]), to255(alpha)]
  }
  m = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(v)
  if (m) { const L = m[1].endsWith('%') ? num(m[1]) / 100 : num(m[1]); return oklchToRgb(L, num(m[2]), num(m[3])) }
  throw new Error(`tokens.css: --${name} is not a colour literal the phone can read: ${v}`)
}
export function tokensFromCss(css) {
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
    const rgb = decls.get('rule-rgb'), alpha = decls.get('rule-alpha')
    if (!rgb || !alpha) throw new Error(`tokens.css: the ${theme} theme has no rule hairline`)
    const [r, g, b] = rgb.split(/\s+/).map(num)
    colors.rule = [r, g, b, to255(num(alpha))]
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
const kotlinColor = ([r, g, b, a]) => `Color(0x${[a, r, g, b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('')})`
export function renderKotlin(tokens) {
  const roleKeys = [...Object.keys(THEME_ROLES), 'rule']
  const lines = []
  lines.push('// Generated from packages/ui/src/tokens.css by apps/mobile-android/scripts/generate-tokens.mjs.')
  lines.push('// Do not edit: run the script again; TokensParityTest fails when this file no longer matches the stylesheet.')
  lines.push('package com.clave.ui.theme')
  lines.push('')
  lines.push('import androidx.compose.ui.graphics.Color')
  lines.push('')
  lines.push('enum class ThemeName(val id: String) {')
  lines.push(THEME_NAMES.map((t) => `    ${t[0].toUpperCase()}${t.slice(1)}("${t}")`).join(',\n') + ';')
  lines.push('')
  lines.push('    companion object {')
  lines.push('        fun of(id: String?): ThemeName? = entries.firstOrNull { it.id == id }')
  lines.push('    }')
  lines.push('}')
  lines.push('')
  lines.push('/** The colour roles of one theme, as the desktop names them. */')
  lines.push('data class ThemeColors(')
  for (const key of roleKeys) lines.push(`    val ${key}: Color,`)
  lines.push(')')
  lines.push('')
  lines.push('/** The roles every theme shares, from the @theme block. */')
  lines.push('data class SharedColors(')
  for (const key of Object.keys(SHARED_ROLES)) lines.push(`    val ${key}: Color,`)
  lines.push(')')
  lines.push('')
  lines.push('object Tokens {')
  for (const theme of THEME_NAMES) {
    lines.push(`    val ${theme} = ThemeColors(`)
    for (const key of roleKeys) lines.push(`        ${key} = ${kotlinColor(tokens.themes[theme][key])},`)
    lines.push('    )')
  }
  lines.push('    val shared = SharedColors(')
  for (const key of Object.keys(SHARED_ROLES)) lines.push(`        ${key} = ${kotlinColor(tokens.shared[key])},`)
  lines.push('    )')
  lines.push(`    const val FONT_WEIGHT_MEDIUM = ${tokens.fontWeightMedium}`)
  lines.push('')
  lines.push('    fun colors(name: ThemeName): ThemeColors = when (name) {')
  for (const theme of THEME_NAMES) lines.push(`        ThemeName.${theme[0].toUpperCase()}${theme.slice(1)} -> ${theme}`)
  lines.push('    }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const source = renderKotlin(tokensFromCss(readFileSync(TOKENS_CSS, 'utf8')))
  writeFileSync(OUT, source)
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${source.length} bytes)`)
}
