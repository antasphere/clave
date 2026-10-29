#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by npm run check:release-bundle */
// The developer connection screen exists in a development build only
// (decision 13 of the spec). This check exports the app's JavaScript twice
// with Metro and inspects the bundles: the development export MUST carry
// the screen's marker (otherwise the check is looking for the wrong thing),
// and the release export MUST NOT (otherwise `__DEV__` stopped gating the
// route). Either way round, it exits non-zero with the file named.
//
//   node scripts/check-release-bundle.mjs [--platform ios|android] [--keep]
//
// The markers: DEVELOPER_CONNECTION_MARKER of src/screens/DeveloperScreen.tsx
// (a string Metro cannot rename), the screen's component name and the
// developer source's class name.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MARKERS = ['clave-mobile:developer-connection', 'DeveloperScreen', 'DeveloperMachineSource']

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

/** Runs `expo export` into a fresh folder and answers the bundle text. */
export function exportBundle({ platform, dev, keep = false, log = console.error }) {
  const out = mkdtempSync(path.join(os.tmpdir(), `clave-mobile-export-${dev ? 'dev' : 'release'}-`))
  const args = ['expo', 'export', '--platform', platform, '--output-dir', out, '--no-bytecode']
  if (dev) args.push('--dev')
  log(`exporting ${dev ? 'development' : 'release'} bundle for ${platform}: npx ${args.join(' ')}`)
  const started = Date.now()
  const result = spawnSync('npx', args, {
    cwd: PKG,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' }
  })
  if (result.status !== 0) {
    throw new Error(`expo export failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  const bundleDir = path.join(out, '_expo', 'static', 'js', platform)
  const files = existsSync(bundleDir)
    ? readdirSync(bundleDir).filter((f) => f.endsWith('.js') || f.endsWith('.hbc'))
    : []
  if (files.length === 0) throw new Error(`no bundle written under ${bundleDir}`)
  const text = files.map((f) => readFileSync(path.join(bundleDir, f), 'latin1')).join('\n')
  const bytes = files.reduce((n, f) => n + statSync(path.join(bundleDir, f)).size, 0)
  log(
    `${dev ? 'development' : 'release'} bundle: ${files.join(', ')} (${(bytes / 1024).toFixed(0)} KiB) in ${((Date.now() - started) / 1000).toFixed(0)} s`
  )
  if (!keep) rmSync(out, { recursive: true, force: true })
  return { text, files, bytes }
}

/** Which markers the text carries. */
export const markersIn = (text) => MARKERS.filter((marker) => text.includes(marker))

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const platform = arg('platform', 'ios')
  const keep = process.argv.includes('--keep')
  let failed = false
  const dev = exportBundle({ platform, dev: true, keep })
  const devMarkers = markersIn(dev.text)
  if (devMarkers.length !== MARKERS.length) {
    console.error(
      `FAIL: the development bundle lacks ${MARKERS.filter((m) => !devMarkers.includes(m)).join(', ')}; the check would be looking for the wrong thing`
    )
    failed = true
  } else
    console.error(
      `ok: the development bundle carries the developer screen (${devMarkers.join(', ')})`
    )
  const release = exportBundle({ platform, dev: false, keep })
  const releaseMarkers = markersIn(release.text)
  if (releaseMarkers.length > 0) {
    console.error(
      `FAIL: the release bundle carries ${releaseMarkers.join(', ')}; the developer connection must be absent from a non-development build`
    )
    failed = true
  } else console.error('ok: the release bundle carries no developer connection')
  process.exit(failed ? 1 : 0)
}
