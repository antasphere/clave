#!/usr/bin/env node

// Geist Sans for the phone, derived from the very files the desktop loads:
// @fontsource/geist-sans ships the OFL-licensed face as WOFF (zlib-wrapped
// sfnt) and WOFF2; the phone's text engines read OpenType, so each WOFF of
// the three weights the desktop uses (400, 500, 600; `--font-weight-medium`
// resolves to 400) is unwrapped into an OTF (CFF outlines, as Vercel ships it) with fontTools, byte-for-byte the
// same glyphs. The OFL text ships beside them. Needs `uv` (fontTools is
// fetched into an ephemeral environment); the OTFs are committed, so a
// checkout never needs to run this.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pkg = path.dirname(require.resolve('@fontsource/geist-sans/package.json'))
const out = path.resolve(here, '..', 'assets', 'fonts')
mkdirSync(out, { recursive: true })

export const FACES = [
  { weight: 400, file: 'Geist-Regular.otf' },
  { weight: 500, file: 'Geist-Medium.otf' },
  { weight: 600, file: 'Geist-SemiBold.otf' }
]

const script = `
import sys
from fontTools.ttLib import TTFont
src, dst = sys.argv[1], sys.argv[2]
font = TTFont(src)
font.flavor = None
font.save(dst)
`
for (const { weight, file } of FACES) {
  const src = path.join(pkg, 'files', `geist-sans-latin-${weight}-normal.woff`)
  if (!existsSync(src)) throw new Error(`missing ${src}`)
  const dst = path.join(out, file)
  const run = spawnSync('uv', ['run', '--quiet', '--with', 'fonttools', 'python', '-', src, dst], {
    input: script,
    encoding: 'utf8'
  })
  if (run.status !== 0) throw new Error(`fontTools failed for ${file}: ${run.stderr}`)
  console.log(`wrote ${path.relative(process.cwd(), dst)} (${statSync(dst).size} bytes)`)
}
copyFileSync(path.join(pkg, 'LICENSE'), path.join(out, 'OFL.txt'))
console.log('copied OFL.txt')
