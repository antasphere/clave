// The bundled skins are GENERATED from the design system: `tokens.css`
// declares the custom properties, `excluded-token-names.json` names the ones a
// skin may not touch (metrics, fonts, easing: the stylesheet's own), and the
// four packages under `skins/` carry everything else, theme by theme.
// `extractSkins` is the pure half, so a test can prove the committed files are
// what the stylesheet says (`extract-skins.test.mjs`, PRDCT-4169): a skin that
// misses a token the theme declares, or carries one the exclusion list took
// back, is a red test and not a dirty tree after the next run.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

export const root = fileURLToPath(new URL('../', import.meta.url))
export const TOKENS_CSS = `${root}../ui/src/tokens.css`
export const EXCLUDED_FILE = `${root}excluded-token-names.json`
export const TOKEN_NAMES_FILE = `${root}token-names.json`
export const SKIN_IDS = ['dark', 'charcoal', 'light', 'coffee']

/** The token inventory and the four skins' token maps, from the stylesheet's
 *  text and the exclusion list. Pure: reads nothing, writes nothing. */
export function extractSkins(cssText, excludedNames) {
  const css = postcss.parse(cssText)
  const excluded = new Set(excludedNames)
  const names = new Set()
  css.walkDecls((d) => {
    if (d.prop.startsWith('--') && !excluded.has(d.prop)) names.add(d.prop)
  })
  const defaults = {}
  css.walkAtRules('theme', (rule) =>
    rule.walkDecls((d) => {
      if (names.has(d.prop)) defaults[d.prop] = d.value
    })
  )
  const themes = {}
  css.walkRules((rule) => {
    const id = rule.selector.match(/\[data-theme="(.*?)"\]/)?.[1]
    if (!id) return
    themes[id] = {}
    rule.walkDecls((d) => {
      if (names.has(d.prop)) themes[id][d.prop] = d.value
    })
  })
  const skins = {}
  for (const id of SKIN_IDS) skins[id] = { ...defaults, ...themes.dark, ...themes[id] }
  return { tokenNames: [...names].sort(), skins }
}

/** The manifest written beside each skin's tokens. */
export function manifestFor(id) {
  return {
    kind: 'skin',
    id,
    name: id[0].toUpperCase() + id.slice(1),
    version: '1.0.0',
    engines: { clave: '>=1.90.2' },
    skin: { tokens: 'skin.json', base: ['light', 'coffee'].includes(id) ? 'light' : 'dark' }
  }
}

/** What the checkout's stylesheet and exclusion list say the files should be. */
export function extractFromCheckout() {
  return extractSkins(
    readFileSync(TOKENS_CSS, 'utf8'),
    JSON.parse(readFileSync(EXCLUDED_FILE, 'utf8'))
  )
}

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** Run as a script (never when imported by the test): the entry point is this
 *  file, compared by real path so a symlinked checkout still writes. */
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const { tokenNames, skins } = extractFromCheckout()
  writeFileSync(TOKEN_NAMES_FILE, json(tokenNames))
  for (const id of SKIN_IDS) {
    const dir = `${root}skins/${id}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/skin.json`, json(skins[id]))
    writeFileSync(`${dir}/clave-plugin.json`, json(manifestFor(id)))
  }
}
