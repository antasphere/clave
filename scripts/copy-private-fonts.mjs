#!/usr/bin/env node
// Copies fonts Clave may USE but must not REDISTRIBUTE into the renderer, from
// the private Antasphere workspace, so they never enter this public repository.
//
// Synonym (Fontshare, ITF Free Font License) is the website's body face. Its
// licence forbids distributing the font file through a repository, and
// antasphere/clave is public: the file lives in the (private) website repo and
// is copied into a git-ignored folder at build time. Where the workspace is not
// there — a fork, a contributor's clone, CI — this is a no-op, the glob in
// src/renderer/src/lib/ui-font.ts finds nothing, and Appearance → Font only
// offers Geist.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// clave-app sits at <workspace>/labs/products/clave/clave-app.
const WORKSPACE = path.resolve(REPO, '..', '..', '..', '..')
const DEST = path.join(REPO, 'src/renderer/src/assets/fonts/private')

const FONTS = ['company/website/apps/website/src/assets/fonts/synonym/Synonym-Variable.woff2']

for (const rel of FONTS) {
  const from = path.join(WORKSPACE, rel)
  if (!existsSync(from)) {
    console.log(`[fonts] ${path.basename(rel)} not in this workspace — skipped`)
    continue
  }
  mkdirSync(DEST, { recursive: true })
  copyFileSync(from, path.join(DEST, path.basename(rel)))
  console.log(`[fonts] ${path.basename(rel)} copied`)
}
