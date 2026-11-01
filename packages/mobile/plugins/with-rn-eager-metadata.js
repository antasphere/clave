/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- Expo config plugin, plain Node JS */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// Candidate compatibility correction for Clave's pinned OSS iOS distribution.
// Sample's API/spec remains available, but is not advertised for eager native
// bootstrap. All six core main-queue annotations stay intact. This changes the
// codegen INPUT, never a runtime list or lookup. The internal
// RN_DISABLE_OSS_PLUGIN_HEADER provider is separate and is not corrected here.
// Compiled/prebuilt applicability still needs a fresh native-artifact check.
const VERSION = '0.88.1'
const ORIGINAL = '3f2bf69ed883e97a295b1de43f5a2d75d112ab45495153360c2fb521023c7f3f'
const PATCHED = 'fbc4960eab2d5fca3036b7fb9475dfa0e2129e08e2c60e39fc23bc705f585fb1'
const BEFORE = '"SampleTurboModule": {\n              "unstableRequiresMainQueueSetup": true'
const AFTER = '"SampleTurboModule": {\n              "unstableRequiresMainQueueSetup": false'
const sha = (source) => createHash('sha256').update(source).digest('hex')

function applyRnEagerMetadataFix(projectRoot) {
  const file = require.resolve('react-native/package.json', { paths: [projectRoot] })
  // Prebuild may resolve a hoisted dependency. Refuse a linked external graph:
  // applying this app's correction must never modify another checkout/cache.
  const root = path.resolve(fs.realpathSync(projectRoot), '../..')
  const relative = path.relative(root, fs.realpathSync(file))
  if (
    relative !== 'node_modules/react-native/package.json' &&
    relative !== 'packages/mobile/node_modules/react-native/package.json'
  )
    throw new Error('with-rn-eager-metadata: expected an app-owned RN graph; refusing to patch')
  const source = fs.readFileSync(file, 'utf8')
  if (JSON.parse(source).version !== VERSION)
    throw new Error('with-rn-eager-metadata: expected react-native 0.88.1; review the candidate')
  const before = sha(source)
  if (before === PATCHED) return { file, did: 'already patched', sha256: before }
  if (before !== ORIGINAL)
    throw new Error('with-rn-eager-metadata: unknown RN metadata layout; refusing to patch')
  const patched = source.replace(BEFORE, AFTER)
  if (sha(patched) !== PATCHED)
    throw new Error('with-rn-eager-metadata: unexpected correction output; refusing to write')
  // Replace the directory entry rather than writing through an inode that may
  // also belong to a hardlinked cache outside this project.
  const mode = fs.statSync(file).mode & 0o7777
  const temporary = fs.mkdtempSync(path.join(path.dirname(file), '.clave-rn-eager-'))
  try {
    const candidate = path.join(temporary, 'package.json')
    fs.writeFileSync(candidate, patched, { mode })
    fs.chmodSync(candidate, mode)
    fs.renameSync(candidate, file)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  return { file, did: 'patched', sha256: PATCHED }
}

module.exports = function withRnEagerMetadata(config) {
  const { withDangerousMod } = require('expo/config-plugins')
  // Expo runs dangerous mods before the other iOS mods and CocoaPods codegen.
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const result = applyRnEagerMetadataFix(config.modRequest.projectRoot)
      console.log(`» with-rn-eager-metadata: ${result.did}`)
      return config
    }
  ])
}
module.exports.applyRnEagerMetadataFix = applyRnEagerMetadataFix
