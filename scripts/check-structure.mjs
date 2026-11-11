/* eslint-disable @typescript-eslint/explicit-function-return-type -- Repository tooling. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
)
const required = [
  'apps/desktop/src/main/index.ts',
  'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/index.html',
  'apps/server/src/main.ts',
  'apps/terminals/src/main.ts',
  'apps/terminals/src/probe.ts',
  'apps/pi-state/index.js',
  'apps/plugin-runner/src/main.ts',
  'apps/relay/src/main.ts',
  'apps/channel/bin/clave-channel.js',
  'apps/plugins/analytics/src/main.ts',
  'apps/native/secure-files/main.c',
  'apps/native/haptic/main.swift',
  'apps/native/mission-control/main.swift',
  'packages/host/src',
  'packages/shared/src',
  'packages/mobile-native/fixtures/index.json',
  'packages/mobile-native/assets/tokens.json',
  'packages/mobile-native/scripts/fixture-server.mjs'
]
for (const file of required)
  assert(existsSync(path.join(root, file)), `Missing app/package home: ${file}`)

// The native phone apps (the native mobile wave of 9 November 2026) are not
// npm workspaces and hold no JavaScript: a SwiftUI project and a Gradle
// project, each built and tested by one entry at its root, `ci.sh`, which
// .github/workflows/mobile.yml runs. A folder that exists without the entry
// would be skipped by the workflow in silence, so the guard requires it, a
// regular file as the workflow tests it (`[ -f … ]`); a package.json anywhere
// in one would mean a JavaScript toolchain crept into a native app, which the
// decision brief forbids. Gradle's and Xcode's build output is left out of
// that search: it is never tracked.
const nativeApps = ['apps/mobile-ios', 'apps/mobile-android']
function* nativeFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['build', '.gradle', '.build', 'DerivedData', '.git'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* nativeFiles(file)
    else yield file
  }
}
for (const home of nativeApps) {
  const directory = path.join(root, home)
  if (!existsSync(directory)) continue
  const entries = readdirSync(directory).filter((name) => name !== '.DS_Store')
  if (entries.length === 0) continue
  const entry = path.join(directory, 'ci.sh')
  assert(
    existsSync(entry) && statSync(entry).isFile(),
    `Native app without its CI entry, a file: ${home}/ci.sh`
  )
  const manifests = [...nativeFiles(directory)].filter(
    (file) => path.basename(file) === 'package.json'
  )
  assert(
    manifests.length === 0,
    `Native app carries a JavaScript manifest: ${manifests.map((file) => path.relative(root, file)).join(', ')}`
  )
}
// An existing checkout can retain ignored build output after tracked source moves.
const legacyGenerated = [
  'src/renderer/src/assets/fonts/private',
  'plugins/analytics/main.mjs',
  'plugins/analytics/dist',
  'packages/mobile/ios',
  'packages/mobile/android',
  'packages/mobile/.expo',
  'packages/mobile/expo-env.d.ts',
  'packages/mobile/e2e/.output',
  // The React Native app's own generated output, after its retirement from apps/mobile.
  'apps/mobile/ios',
  'apps/mobile/android',
  'apps/mobile/.expo',
  'apps/mobile/expo-env.d.ts',
  'apps/mobile/e2e/.output'
].map((file) => path.join(root, file))

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'out', '.git', '.DS_Store', 'Thumbs.db'].includes(entry.name))
      continue
    const file = path.join(dir, entry.name)
    if (
      legacyGenerated.some(
        (generated) => file === generated || file.startsWith(generated + path.sep)
      )
    )
      continue
    if (entry.isDirectory()) yield* files(file)
    else if (entry.isFile()) yield file
  }
}

const obsoleteHomes = [
  'src',
  'native',
  'plugins',
  'packages/mobile',
  // The React Native app, retired for the two native apps: kept on the branch
  // mobile-react-native-baseline-20261109, never to come back here.
  'apps/mobile',
  'packages/server/src/relay/main.ts',
  'packages/clave-channel/bin'
]
// A generated path that covered a whole obsolete home would let any source
// back into it, every file of it then read as generated output.
for (const home of obsoleteHomes) {
  const directory = path.join(root, home)
  assert(
    !legacyGenerated.some(
      (generated) => directory === generated || directory.startsWith(generated + path.sep)
    ),
    `Obsolete source home listed as generated output: ${home}`
  )
}
for (const home of obsoleteHomes) {
  const directory = path.join(root, home)
  if (!existsSync(directory)) continue
  const entries = statSync(directory).isDirectory() ? files(directory) : [directory]
  for (const file of entries) {
    assert(
      legacyGenerated.some(
        (generated) => file === generated || file.startsWith(generated + path.sep)
      ),
      `Obsolete source home: ${path.relative(root, file)}`
    )
  }
}

// Workspace names and the renderer alias resolve to app source too.
const { workspaces } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
assert(Array.isArray(workspaces), 'Expected the root workspace directory list')
const appImports = workspaces
  .filter((directory) => directory.startsWith('apps/'))
  .map(
    (directory) => JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')).name
  )
appImports.push('@renderer')

for (const file of files(path.join(root, 'packages'))) {
  const relative = path.relative(root, file)
  if (path.basename(file) === 'package.json') {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    assert(!pkg.bin, `Library declares an executable: ${relative}`)
    for (const name of ['start', 'serve', 'android', 'ios'])
      assert(
        !pkg.scripts?.[name],
        `Runnable script belongs under apps/: ${relative} scripts.${name}`
      )
  }
  if (
    !/\.(?:ts|tsx|js|mjs|cjs)$/.test(file) ||
    /\.(?:test|fixtures)(?:\.|$)/.test(file) ||
    relative.includes('/scripts/')
  )
    continue
  const source = readFileSync(file, 'utf8')
  assert(!source.startsWith('#!'), `Executable source belongs under apps/: ${relative}`)
  const imports = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(imports)) {
    assert(
      !appImports.some((name) => match[1] === name || match[1].startsWith(`${name}/`)),
      `Shared code imports an app: ${relative} -> ${match[1]}`
    )
    if (!match[1].startsWith('.')) continue
    const target = path.resolve(path.dirname(file), match[1])
    assert(
      !target.startsWith(path.join(root, 'apps') + path.sep),
      `Shared code imports an app: ${relative} -> ${match[1]}`
    )
  }
}
console.log(
  'Structure checked: runnable apps, reusable packages, no production package-to-app imports.'
)
