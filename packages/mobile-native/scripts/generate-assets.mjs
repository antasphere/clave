#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node and imported by a vitest */
// The assets both native phones read, generated from what the desktop itself
// ships so that neither phone restates a colour, a size, a glyph or a face by
// hand:
//
// - assets/tokens.json   the colour roles and spec numbers of
//                        packages/ui/src/tokens.css (tokens-from-css.mjs);
// - assets/icons.json    Heroicons 24/outline, read out of the very
//                        @heroicons/react modules the renderer imports, plus the
//                        provider marks of cli-logos.tsx; and each glyph as an
//                        SVG (iOS) and an Android VectorDrawable, white, tinted
//                        at render time the way the desktop paints currentColor;
// - assets/fonts/        Geist Sans at the three weights the desktop loads,
//                        unwrapped from @fontsource/geist-sans's WOFF files into
//                        OTF (woff-to-otf.mjs), with the package's OFL licence.
//
// `node scripts/generate-assets.mjs` writes them; `--check` writes nothing and
// exits 1 naming every file that differs. assets.test.mjs holds the committed
// folder to `generateAll`, so a stylesheet change without a run fails, named.
// Adding an icon is one name in ICONS below and a run.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEME_NAMES, fontSansFromCss, specFromCss, tokensFromCss } from './tokens-from-css.mjs'
import { fontNames, sha256Hex, woffToOtf } from './woff-to-otf.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export const TOKENS_SOURCE = 'packages/ui/src/tokens.css'
export const LOGOS_SOURCE = 'apps/desktop/src/renderer/src/components/icons/cli-logos.tsx'
export const ASSETS_DIR = 'packages/mobile-native/assets'
const HEROICONS_PACKAGE = 'node_modules/@heroicons/react'
const FONTS_PACKAGE = 'node_modules/@fontsource/geist-sans'

const COMMAND = '`npm run assets --workspace @clave/mobile-native`'
const comment = (source) =>
  `Generated from ${source} by packages/mobile-native/scripts/generate-assets.mjs. Do not edit: run ${COMMAND}; assets.test.mjs fails when this file no longer matches its source.`

/** phone name → Heroicons 24/outline component (apps/mobile's set). */
export const ICONS = {
  'arrow-left': 'ArrowLeftIcon',
  'arrow-path': 'ArrowPathIcon',
  'arrow-up': 'ArrowUpIcon',
  'arrow-turn-down-right': 'ArrowTurnDownRightIcon',
  'book-open': 'BookOpenIcon',
  camera: 'CameraIcon',
  'chat-bubble-left-right': 'ChatBubbleLeftRightIcon',
  check: 'CheckIcon',
  'chevron-down': 'ChevronDownIcon',
  'chevron-right': 'ChevronRightIcon',
  'clipboard-document': 'ClipboardDocumentIcon',
  'command-line': 'CommandLineIcon',
  'computer-desktop': 'ComputerDesktopIcon',
  'cpu-chip': 'CpuChipIcon',
  document: 'DocumentIcon',
  'document-text': 'DocumentTextIcon',
  'ellipsis-horizontal': 'EllipsisHorizontalIcon',
  'exclamation-triangle': 'ExclamationTriangleIcon',
  eye: 'EyeIcon',
  'eye-slash': 'EyeSlashIcon',
  folder: 'FolderIcon',
  'globe-alt': 'GlobeAltIcon',
  'inbox-stack': 'InboxStackIcon',
  'magnifying-glass': 'MagnifyingGlassIcon',
  'paint-brush': 'PaintBrushIcon',
  'paper-clip': 'PaperClipIcon',
  'pencil-square': 'PencilSquareIcon',
  photo: 'PhotoIcon',
  plus: 'PlusIcon',
  'question-mark-circle': 'QuestionMarkCircleIcon',
  'server-stack': 'ServerStackIcon',
  'shield-check': 'ShieldCheckIcon',
  stop: 'StopIcon',
  'user-circle': 'UserCircleIcon',
  wrench: 'WrenchIcon',
  'x-mark': 'XMarkIcon'
}

/** The provider marks, by the component's name in cli-logos.tsx. */
export const LOGOS = {
  'logo-antigravity': 'AntigravityLogo',
  'logo-claude': 'ClaudeLogo',
  'logo-codex': 'CodexLogo',
  'logo-pi': 'PiLogo'
}

/** The three faces the desktop loads (`--font-weight-medium` resolves to 400). */
export const FACES = [
  { weight: 400, file: 'Geist-Regular.otf' },
  { weight: 500, file: 'Geist-Medium.otf' },
  { weight: 600, file: 'Geist-SemiBold.otf' }
]

const STROKE = { width: 1.5, linecap: 'round', linejoin: 'round' }
const WHITE = '#ffffff'

/** A value with every object's keys sorted, arrays kept in order. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    )
  return value
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** tokens.json from the stylesheet's text. */
export function renderTokens(css) {
  const { themes, shared, fontWeightMedium } = tokensFromCss(css)
  const spec = sortKeys(specFromCss(css))
  const orderedThemes = {}
  for (const theme of THEME_NAMES) orderedThemes[theme] = sortKeys(themes[theme])
  return json({
    $comment: comment(TOKENS_SOURCE).replace('its source', 'the stylesheet'),
    source: TOKENS_SOURCE,
    themes: orderedThemes,
    shared: sortKeys(shared),
    control: spec.control,
    frame: spec.frame,
    radius: spec.radius,
    controlHeights: spec.controlHeights,
    sidebar: spec.sidebar,
    typography: { fontSans: fontSansFromCss(css), fontWeightMedium }
  })
}

function heroiconPaths(heroiconsDir, component) {
  const source = readFileSync(
    path.join(heroiconsDir, '24', 'outline', 'esm', `${component}.js`),
    'utf8'
  )
  const paths = [...source.matchAll(/\bd: "([^"]+)"/g)].map((m) => m[1])
  if (!paths.length) throw new Error(`${component}: no path found`)
  return paths
}

function logoShape(logosSource, component) {
  const start = logosSource.indexOf(`export function ${component}(`)
  if (start < 0) throw new Error(`${component}: not in cli-logos.tsx`)
  const end = logosSource.indexOf('\nexport function', start + 1)
  const block = logosSource.slice(start, end < 0 ? undefined : end)
  const viewBox = /viewBox="([^"]+)"/.exec(block)?.[1] ?? '0 0 24 24'
  const paths = [...block.matchAll(/<path([^>]*?)\/>/g)].map((m) => {
    const attrs = m[1]
    const d = /\bd="([^"]+)"/.exec(attrs)?.[1]
    if (!d) throw new Error(`${component}: a path without d`)
    const fillRule = /fillRule="([^"]+)"/.exec(attrs)?.[1]
    return fillRule ? { d, fillRule } : { d }
  })
  if (!paths.length) throw new Error(`${component}: no path found`)
  return { viewBox, paths }
}

const iconSvg = (paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${WHITE}" stroke-width="${STROKE.width}" stroke-linecap="${STROKE.linecap}" stroke-linejoin="${STROKE.linejoin}">${paths.map((d) => `<path d="${escapeXml(d)}"/>`).join('')}</svg>\n`

const logoSvg = ({ viewBox, paths }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${paths
    .map(
      (p) =>
        `<path d="${escapeXml(p.d)}" fill="${WHITE}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ''}/>`
    )
    .join('')}</svg>\n`

function viewport(viewBox) {
  const [, , w, h] = viewBox.split(/[\s,]+/).map(Number)
  if (!(w > 0 && h > 0)) throw new Error(`a viewBox the drawable cannot use: ${viewBox}`)
  return { w, h }
}

function vectorDrawable(viewBox, pathLines) {
  const { w, h } = viewport(viewBox)
  const lines = [
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '    android:width="24dp"',
    '    android:height="24dp"',
    `    android:viewportWidth="${w}"`,
    `    android:viewportHeight="${h}">`
  ]
  for (const attrs of pathLines) {
    lines.push('    <path')
    attrs.forEach((a, i) => lines.push(`        ${a}${i === attrs.length - 1 ? ' />' : ''}`))
  }
  lines.push('</vector>')
  return `${lines.join('\n')}\n`
}

const iconDrawable = (paths) =>
  vectorDrawable(
    '0 0 24 24',
    paths.map((d) => [
      'android:fillColor="#00000000"',
      'android:strokeColor="#FFFFFFFF"',
      `android:strokeWidth="${STROKE.width}"`,
      'android:strokeLineCap="round"',
      'android:strokeLineJoin="round"',
      `android:pathData="${escapeXml(d)}"`
    ])
  )

const logoDrawable = ({ viewBox, paths }) =>
  vectorDrawable(
    viewBox,
    paths.map((p) => [
      'android:fillColor="#FFFFFFFF"',
      `android:pathData="${escapeXml(p.d)}"`,
      ...(p.fillRule === 'evenodd' ? ['android:fillType="evenOdd"'] : [])
    ])
  )

/** Android resource name of an icon: lowercase letters, digits, underscores. */
export function drawableName(name) {
  const res = `ic_${name.replace(/-/g, '_')}`
  if (!/^[a-z][a-z0-9_]*$/.test(res)) throw new Error(`${name}: not a valid Android resource name`)
  return `${res}.xml`
}

/** icons.json, the SVGs and the VectorDrawables. */
export function renderIcons({ heroiconsDir, heroiconsVersion, logosSource }) {
  const icons = {}
  const logos = {}
  const svgs = new Map()
  const drawables = new Map()
  for (const name of Object.keys(ICONS).sort()) {
    const component = ICONS[name]
    const paths = heroiconPaths(heroiconsDir, component)
    icons[name] = { component, paths }
    svgs.set(name, iconSvg(paths))
    drawables.set(drawableName(name), iconDrawable(paths))
  }
  for (const name of Object.keys(LOGOS).sort()) {
    const component = LOGOS[name]
    const shape = logoShape(logosSource, component)
    logos[name] = { component, source: LOGOS_SOURCE, viewBox: shape.viewBox, paths: shape.paths }
    svgs.set(name, logoSvg(shape))
    drawables.set(drawableName(name), logoDrawable(shape))
  }
  const body = json({
    $comment: comment(`@heroicons/react (24/outline) and ${LOGOS_SOURCE}`),
    heroicons: {
      package: '@heroicons/react',
      version: heroiconsVersion,
      set: '24/outline',
      license: 'MIT'
    },
    viewBox: '0 0 24 24',
    stroke: STROKE,
    icons,
    logos
  })
  return { json: body, svgs, drawables }
}

/** The three OTFs, their manifest and the licence. */
export function renderFonts({ packageDir, version, cssFamily }) {
  const faces = FACES.map(({ weight, file }) => {
    const source = `files/geist-sans-latin-${weight}-normal.woff`
    const bytes = woffToOtf(readFileSync(path.join(packageDir, source)))
    return { file, weight, source, bytes, ...fontNames(bytes) }
  })
  const families = [...new Set(faces.map((f) => f.family))]
  if (families.length !== 1)
    throw new Error(`the Geist faces name ${families.length} families: ${families.join(', ')}`)
  const metadata = JSON.parse(readFileSync(path.join(packageDir, 'metadata.json'), 'utf8'))
  const upstream = {
    geistRelease: metadata.version,
    upstream: metadata.source,
    attribution: metadata.license?.attribution
  }
  for (const [key, value] of Object.entries(upstream))
    if (typeof value !== 'string' || !value)
      throw new Error(`@fontsource/geist-sans metadata.json: no ${key}`)
  const manifest = json({
    $comment: comment('@fontsource/geist-sans (WOFF, unwrapped to OTF)'),
    package: '@fontsource/geist-sans',
    version,
    ...upstream,
    license: 'OFL-1.1',
    licenseFile: 'OFL.txt',
    // What a phone registers and looks the faces up by, read from each OTF's
    // own name table; the tokens' `typography.fontSans` is the desktop's CSS
    // family, an alias the files themselves do not carry.
    family: families[0],
    cssFamily,
    faces: faces.map(({ weight, file, source, bytes, postScriptName }) => ({
      weight,
      file,
      postScriptName,
      source,
      sha256: sha256Hex(bytes)
    }))
  })
  const license = readFileSync(path.join(packageDir, 'LICENSE'), 'utf8')
  return {
    faces: faces.map(({ file, weight, bytes }) => ({ file, weight, bytes })),
    manifest,
    license
  }
}

const packageVersion = (dir) =>
  JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version

/** Every output, relative path under the assets folder → content. */
export function generateAll(repoRoot) {
  const out = new Map()
  const css = readFileSync(path.join(repoRoot, TOKENS_SOURCE), 'utf8')
  out.set('tokens.json', renderTokens(css))
  const heroiconsDir = path.join(repoRoot, HEROICONS_PACKAGE)
  const icons = renderIcons({
    heroiconsDir,
    heroiconsVersion: packageVersion(heroiconsDir),
    logosSource: readFileSync(path.join(repoRoot, LOGOS_SOURCE), 'utf8')
  })
  out.set('icons.json', icons.json)
  for (const [name, svg] of icons.svgs) out.set(`icons/svg/${name}.svg`, svg)
  for (const [file, xml] of icons.drawables) out.set(`icons/android/${file}`, xml)
  const fontsDir = path.join(repoRoot, FONTS_PACKAGE)
  const fonts = renderFonts({
    packageDir: fontsDir,
    version: packageVersion(fontsDir),
    cssFamily: fontSansFromCss(css)
  })
  for (const face of fonts.faces) out.set(`fonts/${face.file}`, face.bytes)
  out.set('fonts/OFL.txt', fonts.license)
  out.set('fonts/fonts.json', fonts.manifest)
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Every file under a folder, as forward-slash paths relative to it. */
export function listFiles(dir) {
  const files = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(child)
      else files.push(child)
    }
  }
  walk('')
  return files.sort()
}

const toBuffer = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'))

function main(argv) {
  const repoRoot = path.resolve(here, '..', '..', '..')
  const assets = path.join(repoRoot, ASSETS_DIR)
  const generated = generateAll(repoRoot)
  const onDisk = listFiles(assets)
  const stray = onDisk.filter((f) => !generated.has(f))
  if (argv.includes('--check')) {
    const differ = []
    for (const [rel, content] of generated) {
      let current
      try {
        current = readFileSync(path.join(assets, rel))
      } catch {
        differ.push(`${rel} (missing)`)
        continue
      }
      if (!current.equals(toBuffer(content))) differ.push(rel)
    }
    for (const rel of stray) differ.push(`${rel} (not generated)`)
    if (differ.length) {
      for (const d of differ) console.error(`differs: ${ASSETS_DIR}/${d}`)
      console.error(`${differ.length} file(s) out of date: run ${COMMAND}`)
      process.exit(1)
    }
    console.log(`${generated.size} files match`)
    return
  }
  for (const rel of stray) rmSync(path.join(assets, rel))
  for (const [rel, content] of generated) {
    const file = path.join(assets, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, toBuffer(content))
  }
  let bytes = 0
  for (const rel of generated.keys()) bytes += statSync(path.join(assets, rel)).size
  console.log(
    `wrote ${generated.size} files (${bytes} bytes) to ${ASSETS_DIR}${stray.length ? `, removed ${stray.length} stray` : ''}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2))
