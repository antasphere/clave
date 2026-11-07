/* eslint-disable @typescript-eslint/explicit-function-return-type -- Repository tooling. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
)
const required = [
  'apps/desktop/src/main/index.ts',
  'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/index.html',
  'apps/mobile/index.ts',
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
  'packages/shared/src'
]
for (const file of required)
  assert(existsSync(path.join(root, file)), `Missing app/package home: ${file}`)
for (const file of [
  'src',
  'native',
  'plugins',
  'packages/mobile',
  'packages/server/src/relay/main.ts',
  'packages/clave-channel/bin'
])
  assert(!existsSync(path.join(root, file)), `Obsolete source home: ${file}`)

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'out', '.git'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* files(file)
    else if (entry.isFile()) yield file
  }
}

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
  const imports = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(imports)) {
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
