/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- Expo config plugin, plain Node JS */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// Expo #52462 reports Task.immediate losing the JavaScriptActor executor on
// iOS 26.0 / Swift 6.2. Keep this separate from the Xcode pointer compile fix.
// Four scheduler entry points change; the promise polyfill remains untouched.
const VERSION = '58.0.21'
const ORIGINAL = 'ae9d35493f078a76a312e5acd443eced2a5922c7bfb182ada6eaab1bb0563147'
const PATCHED = '48491dcb17bc062c8ea47166e0abf19ff972befff4fa5f294048cbfd1fadf262'
const SOURCE = 'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift'
const sha = (source) => createHash('sha256').update(source).digest('hex')

function applyJsiSchedulerFix(projectRoot) {
  const pkg = require.resolve('expo-modules-jsi/package.json', { paths: [projectRoot] })
  if (JSON.parse(fs.readFileSync(pkg, 'utf8')).version !== VERSION)
    throw new Error('with-jsi-scheduler: expected expo-modules-jsi 58.0.21; review the workaround')
  const file = path.join(path.dirname(pkg), SOURCE)
  const source = fs.readFileSync(file, 'utf8')
  const before = sha(source)
  if (before === PATCHED) return { file, did: 'already patched', sha256: before }
  if (before !== ORIGINAL)
    throw new Error('with-jsi-scheduler: unknown scheduler source; refusing to patch')
  const patched = source
    .replaceAll('Task.immediate_polyfill {', 'Task(priority: .high) {')
    .replaceAll('Task.immediate_polyfill(priority: .high', 'Task(priority: .high')
  if (sha(patched) !== PATCHED)
    throw new Error('with-jsi-scheduler: unexpected correction output; refusing to write')
  fs.writeFileSync(file, patched)
  return { file, did: 'patched', sha256: PATCHED }
}

module.exports = function withJsiScheduler(config) {
  const { withDangerousMod } = require('expo/config-plugins')
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const result = applyJsiSchedulerFix(config.modRequest.projectRoot)
      console.log(`» with-jsi-scheduler: ${result.did}`)
      return config
    }
  ])
}
module.exports.applyJsiSchedulerFix = applyJsiSchedulerFix
