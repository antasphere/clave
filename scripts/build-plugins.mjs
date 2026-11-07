/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript build tooling */
/**
 * Builds the bundled plugins whose sources are TypeScript: today `apps/plugins/analytics`.
 * Its runnable `main.mjs` and its page assets under `dist/` (the deck page and the settings
 * page, their scripts, one stylesheet) are build outputs (git-ignored), produced here for
 * `electron-vite dev` / `build` (through the inline vite plugin in electron.vite.config.ts)
 * and by `npm run plugins:build`. A file whose content did not change is not rewritten, so
 * a rebuild touches nothing it does not have to.
 */
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = path.join(root, 'apps', 'plugins', 'analytics')
const dist = path.join(plugin, 'dist')
// Generated code is not linted: the config ignores `dist/`, and this line marks `main.mjs`.
const BANNER = [
  '// Built by scripts/build-plugins.mjs from its TypeScript sources; never edit this file.',
  '/* eslint-disable */'
].join('\n')

function writeIfChanged(file, content) {
  const bytes = Buffer.from(content)
  const same = existsSync(file) && readFileSync(file).equals(bytes)
  if (!same) writeFileSync(file, bytes)
  const kb = (bytes.length / 1024).toFixed(1)
  console.log(`${same ? 'unchanged' : 'built'} ${path.relative(root, file)} (${kb} kB)`)
}

async function bundle(entry, outfile, options) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    write: false,
    logLevel: 'warning',
    banner: { js: BANNER },
    ...options
  })
  const out = result.outputFiles.find((f) => f.path === outfile) ?? result.outputFiles[0]
  writeIfChanged(outfile, out.contents)
}

function fontFace(weight) {
  const file = path.join(
    root,
    'node_modules',
    '@fontsource',
    'geist-sans',
    'files',
    `geist-sans-latin-${weight}-normal.woff2`
  )
  const data = readFileSync(file).toString('base64')
  return [
    '@font-face {',
    "  font-family: 'Geist Sans';",
    '  font-style: normal;',
    '  font-display: swap;',
    `  font-weight: ${weight};`,
    `  src: url(data:font/woff2;base64,${data}) format('woff2');`,
    '}'
  ].join('\n')
}

/**
 * tokens.css opens with Tailwind's `@theme` block, which a browser drops as an unknown
 * at-rule; Tailwind itself emits those variables on `:root`, so the page does the same.
 */
function tokensForBrowser() {
  const css = readFileSync(path.join(root, 'packages', 'ui', 'src', 'tokens.css'), 'utf8')
  return css.replace(/^@theme\s*\{/m, ':root {')
}

export async function buildPlugins() {
  copyFileSync(path.join(root, 'apps/pi-state/index.js'), path.join(root, 'resources/pi-clave-state.js'))
  mkdirSync(dist, { recursive: true })
  await bundle(path.join(plugin, 'src', 'main.ts'), path.join(plugin, 'main.mjs'), {
    format: 'esm',
    platform: 'node',
    target: 'node22'
  })
  for (const page of ['deck', 'settings']) {
    await bundle(path.join(plugin, 'page', `${page}.ts`), path.join(dist, `${page}.js`), {
      format: 'iife',
      platform: 'browser',
      target: 'es2022'
    })
  }
  // The whole design system, so a page is built from the app's own classes
  // (the side panel's tab frame, its icon buttons, the floating card) and
  // follows the density presets; inside Clave the host injects the root's
  // resolved tokens on top, so Appearance (theme, density, text size) reaches
  // the page; in a browser the tokens' own defaults stand.
  const ui = (name) => readFileSync(path.join(root, 'packages', 'ui', 'src', name), 'utf8')
  const css = [
    `/* Built by scripts/build-plugins.mjs: Geist Sans, packages/ui/src/{tokens,density,system}.css, page/deck.css, page/settings.css. */`,
    ...[400, 500, 600].map(fontFace),
    tokensForBrowser(),
    ui('density.css'),
    ui('system.css'),
    readFileSync(path.join(plugin, 'page', 'deck.css'), 'utf8'),
    readFileSync(path.join(plugin, 'page', 'settings.css'), 'utf8')
  ].join('\n')
  writeIfChanged(path.join(dist, 'deck.css'), css)
  for (const page of ['index', 'settings']) {
    writeIfChanged(
      path.join(dist, `${page}.html`),
      readFileSync(path.join(plugin, 'page', `${page}.html`), 'utf8')
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPlugins().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
