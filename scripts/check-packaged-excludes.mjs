/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by CI on the packaged app */
// Does the PACKAGED app leave out what must never ship? (issue #407)
//
//   node scripts/check-packaged-excludes.mjs <path/to/Clave.app>
//
// electron-builder packs every file its `files:` patterns do not exclude, so
// a folder added to the repository ships inside app.asar unless a pattern
// says otherwise. `tests/` holds the e2e suite and its fixtures, among them a
// copy of the old relay server (`tests/e2e/fixtures/relay/`), which lives in
// antasphere/relay and must not ride in the desktop app. Nothing at runtime
// reads `tests/`; `electron-builder.yml` excludes it, and this check reads
// the asar's own file list and fails on any path under a forbidden prefix.
// It runs in the same CI step that packages the app for
// `check-packaged-requires.mjs`.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Path prefixes inside app.asar that must not exist. */
export const FORBIDDEN_PREFIXES = ['/tests']

/** The forbidden entries of a list of asar paths. */
export function forbiddenEntries(files, prefixes = FORBIDDEN_PREFIXES) {
  return files.filter((file) =>
    prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))
  )
}

function main() {
  const app = process.argv[2]
  if (!app) {
    console.error('usage: node scripts/check-packaged-excludes.mjs <path/to/Clave.app>')
    process.exit(2)
  }
  const asarPath = path.join(app, 'Contents', 'Resources', 'app.asar')
  if (!existsSync(asarPath)) {
    console.error(`no app.asar at ${asarPath}`)
    process.exit(2)
  }
  // electron-builder's own asar reader, installed with it.
  const asar = createRequire(import.meta.url)('@electron/asar')
  const files = asar.listPackage(asarPath)
  const found = forbiddenEntries(files)
  if (found.length > 0) {
    console.error(
      `app.asar carries ${found.length} path(s) it must not ship:\n` + found.slice(0, 20).join('\n')
    )
    process.exit(1)
  }
  console.log(`app.asar: ${files.length} paths, none under ${FORBIDDEN_PREFIXES.join(', ')}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
