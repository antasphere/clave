#!/usr/bin/env node
// The iPhone app's icons are the desktop's: Heroicons 24/outline, read out of
// the very @heroicons/react modules the renderer imports, plus the provider
// marks of apps/desktop/src/renderer/src/components/icons/cli-logos.tsx. Each
// glyph is written as an SVG into the asset catalog with its vector
// representation preserved and the template rendering intent, so UIKit
// rasterises it at any size and SwiftUI tints it with the foreground style,
// the way the desktop paints `currentColor`. No rasteriser, no dependency.
// Adding an icon is one name in ICONS below and a run of
// `node scripts/build-icons.mjs` in apps/mobile-ios.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const heroicons = path.dirname(require.resolve('@heroicons/react/package.json'))
const logos = path.resolve(
  here,
  '..',
  '..',
  'desktop',
  'src',
  'renderer',
  'src',
  'components',
  'icons',
  'cli-logos.tsx'
)
const catalog = path.resolve(here, '..', 'Clave', 'Resources', 'Assets.xcassets', 'Icons')
const swiftFile = path.resolve(here, '..', 'Clave', 'Theme', 'IconName.swift')

/** phone name → Heroicons 24/outline component. */
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

function heroiconSvg(component) {
  const source = readFileSync(
    path.join(heroicons, '24', 'outline', 'esm', `${component}.js`),
    'utf8'
  )
  const paths = [...source.matchAll(/\bd: "([^"]+)"/g)].map((m) => m[1])
  if (!paths.length) throw new Error(`${component}: no path found`)
  const body = paths.map((d) => `<path d="${d}"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`
}

function logoSvg(component) {
  const source = readFileSync(logos, 'utf8')
  const start = source.indexOf(`export function ${component}(`)
  if (start < 0) throw new Error(`${component}: not in cli-logos.tsx`)
  const end = source.indexOf('\nexport function', start + 1)
  const block = source.slice(start, end < 0 ? undefined : end)
  const viewBox = /viewBox="([^"]+)"/.exec(block)?.[1] ?? '0 0 24 24'
  const paths = [...block.matchAll(/<path([^>]*?)\/>/g)].map((m) => {
    const attrs = m[1]
    const d = /\bd="([^"]+)"/.exec(attrs)?.[1]
    if (!d) throw new Error(`${component}: a path without d`)
    const rule = /fillRule="([^"]+)"/.exec(attrs)?.[1]
    return `<path d="${d}" fill="#000000"${rule ? ` fill-rule="${rule}"` : ''}/>`
  })
  if (!paths.length) throw new Error(`${component}: no path found`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="${viewBox}">${paths.join('')}</svg>\n`
}

// Every glyph declares the same 24pt intrinsic size, whatever its viewBox, so a
// logo and a heroicon sit in the same box before Icon resizes them.
const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const info = { author: 'xcode', version: 1 }

// Start from an empty folder so an icon dropped from the maps leaves no stale set.
rmSync(catalog, { recursive: true, force: true })
mkdirSync(catalog, { recursive: true })
writeFileSync(
  path.join(catalog, 'Contents.json'),
  json({ info, properties: { 'provides-namespace': true } })
)

function write(name, svg) {
  const set = path.join(catalog, `${name}.imageset`)
  mkdirSync(set)
  writeFileSync(path.join(set, `${name}.svg`), svg)
  writeFileSync(
    path.join(set, 'Contents.json'),
    json({
      images: [{ filename: `${name}.svg`, idiom: 'universal' }],
      info,
      properties: {
        'preserves-vector-representation': true,
        'template-rendering-intent': 'template'
      }
    })
  )
}

for (const [name, component] of Object.entries(ICONS)) write(name, heroiconSvg(component))
for (const [name, component] of Object.entries(LOGOS)) write(name, logoSvg(component))

const names = [...Object.keys(ICONS), ...Object.keys(LOGOS)].sort()
const caseName = (kebab) => kebab.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
const lines = [
  '// Generated by apps/mobile-ios/scripts/build-icons.mjs from @heroicons/react (24/outline)',
  '// and apps/desktop/src/renderer/src/components/icons/cli-logos.tsx. Do not edit: run',
  '// `node scripts/build-icons.mjs` in apps/mobile-ios, which also rewrites the Icons folder',
  '// of Assets.xcassets.',
  '',
  'nonisolated public enum IconName: String, CaseIterable, Sendable {',
  ...names.map((n) => `  case ${caseName(n)} = "${n}"`),
  '',
  '  /// The image set inside the catalog\'s namespaced Icons folder.',
  '  public var assetName: String { "Icons/\\(rawValue)" }',
  '}',
  ''
]
writeFileSync(swiftFile, lines.join('\n'))
console.log(
  `wrote ${names.length} icons to ${path.relative(process.cwd(), catalog)} and ${path.relative(process.cwd(), swiftFile)}`
)
