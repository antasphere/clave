/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- standalone Node verification */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { test } = require('node:test')
const withRnEagerMetadata = require('../packages/mobile/plugins/with-rn-eager-metadata')
const { applyRnEagerMetadataFix: apply } = withRnEagerMetadata
const sha = (source) => createHash('sha256').update(source).digest('hex')

// Load the real pinned RN generator read-only. Only its output directories and
// copies of package.json/API files below are writable disposable fixtures.
const rn = path.dirname(require.resolve('react-native/package.json'))
const pkg = process.env.CLAVE_RN_TEST_PACKAGE || path.join(rn, 'package.json')
const input = fs.readFileSync(pkg, 'utf8')
const ORIGINAL = '3f2bf69ed883e97a295b1de43f5a2d75d112ab45495153360c2fb521023c7f3f'
const PATCHED = 'fbc4960eab2d5fca3036b7fb9475dfa0e2129e08e2c60e39fc23bc705f585fb1'
const inputHash = sha(input)
assert.ok([ORIGINAL, PATCHED].includes(inputHash), 'expected exact original or patched RN metadata')
// A completed prebuild leaves the known PATCHED manifest installed. Normalize
// only its fixture baseline, without writing to the selected SDK. Generators
// and APIs always come from the installed pinned SDK, not this input fixture.
const original =
  inputHash === PATCHED
    ? input.replace(
        '"SampleTurboModule": {\n              "unstableRequiresMainQueueSetup": false',
        '"SampleTurboModule": {\n              "unstableRequiresMainQueueSetup": true'
      )
    : input
assert.equal(sha(original), ORIGINAL)
const executor = 'scripts/codegen/generate-artifacts-executor/'
const inputs = {
  [executor + 'generateUnstableModulesRequiringMainQueueSetupProvider.js']:
    'd9e0d17c4213d81582eaef3260191f366025e326f8fd5d8c52199c78967b8530',
  [executor + 'generateAppDependencyProvider.js']:
    '1e993d32cf3bc123e8e51ae90259c0c50448e5fc4500da9f545f07e9c897b24e',
  [executor + 'utils.js']: '99b519bf3e7d753aaf2e5e82fc142750074aad0756f281c947792ffac5d64205',
  [executor + 'constants.js']: '0814b42643d80c646c74f07dc866991fb2e34fe8ffc9ce7356d6c440b0476559',
  'scripts/codegen/templates/RCTUnstableModulesRequiringMainQueueSetupProviderH.template':
    '3641025b5e181f462cce4b4d85ef8ba875719b5588d12c5ed82c8dbe07d04aaf',
  'scripts/codegen/templates/RCTUnstableModulesRequiringMainQueueSetupProviderMM.template':
    '4ca7f513494f38d2d9a9e0fb5000d3da3896075fe9bc2a68b617c67f1ce98a48',
  'scripts/codegen/templates/RCTAppDependencyProviderH.template':
    '3d9be8c0cdfd3ac1630e44678dd50f8a3552f9eec95f85ca216fddc4b7993d03',
  'scripts/codegen/templates/RCTAppDependencyProviderMM.template':
    '2573ea8da41b3eaea8a63fd98b852994816353fd6fda16ce730f07b26199c66c',
  'scripts/codegen/templates/ReactAppDependencyProvider.podspec.template':
    'cc499deecf1202f4e9fd3019b871c80e6f41dcc210922d324ab408bfa70e1694'
}
for (const [file, expected] of Object.entries(inputs))
  assert.equal(sha(fs.readFileSync(path.join(rn, file))), expected, file)
const { extractLibrariesFromJSON } = require(path.join(rn, executor, 'utils.js'))
const { generateUnstableModulesRequiringMainQueueSetupProvider: generate } = require(
  path.join(rn, executor, 'generateUnstableModulesRequiringMainQueueSetupProvider.js')
)
const { generateAppDependencyProvider } = require(
  path.join(rn, executor, 'generateAppDependencyProvider.js')
)
const core = [
  'AccessibilityManager',
  'Appearance',
  'AppState',
  'DeviceInfo',
  'PlatformConstants',
  'StatusBarManager'
]
const apiFiles = [
  'Libraries/TurboModule/samples/NativeSampleTurboModule.js',
  'src/private/specs_DEPRECATED/modules/NativeSampleTurboModule.js',
  'Libraries/TurboModule/TurboModuleRegistry.js'
]

async function fixture(run, source = original) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'clave-rn-eager-'))
  const app = path.join(root, 'packages/mobile')
  const module = path.join(root, 'node_modules/react-native')
  const file = path.join(module, 'package.json')
  fs.mkdirSync(app, { recursive: true })
  fs.mkdirSync(module, { recursive: true })
  fs.writeFileSync(file, source)
  for (const name of apiFiles) {
    fs.mkdirSync(path.dirname(path.join(module, name)), { recursive: true })
    fs.copyFileSync(path.join(rn, name), path.join(module, name))
  }
  try {
    await run({ root, app, module, file })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function generated({ root, module, file }, phase) {
  const output = path.join(root, phase)
  const libraries = extractLibrariesFromJSON(JSON.parse(fs.readFileSync(file, 'utf8')), module)
  generate(libraries, output)
  const source = fs.readFileSync(
    path.join(output, 'RCTUnstableModulesRequiringMainQueueSetupProvider.mm'),
    'utf8'
  )
  const modules = [...source.matchAll(/@"([^"]+)"/g)].map((match) => match[1])
  console.log(JSON.stringify({ phase, modules, sha256: sha(source) }))
  return modules
}

function eligible(modules) {
  assert.deepEqual(modules, core, 'candidate app eager eligibility')
}

test('real codegen baseline RED, corrected GREEN, reinstated flag RED, restored GREEN', async () => {
  await fixture(async (f) => {
    assert.equal(fs.existsSync(path.join(f.app, 'node_modules/react-native')), false)
    assert.equal(
      require.resolve('react-native/package.json', { paths: [f.app] }),
      fs.realpathSync(f.file)
    )
    const baseline = generated(f, 'baseline')
    assert.deepEqual(baseline, [...core.slice(0, 5), 'SampleTurboModule', core[5]])
    assert.throws(() => eligible(baseline), { code: 'ERR_ASSERTION' })
    assert.equal(apply(f.app).did, 'patched')
    eligible(generated(f, 'corrected'))
    const corrected = fs.readFileSync(f.file, 'utf8')
    const before = JSON.parse(original),
      after = JSON.parse(corrected)
    const annotation = after.codegenConfig.libraries[0].ios.modules.SampleTurboModule
    assert.equal(annotation.unstableRequiresMainQueueSetup, false)
    annotation.unstableRequiresMainQueueSetup = true
    assert.deepEqual(
      after,
      before,
      'every other metadata field, including all six flags, is intact'
    )
    assert.equal(apply(f.app).did, 'already patched')
    assert.equal(fs.readFileSync(f.file, 'utf8'), corrected)
    // Undo just the candidate flag, then use the SAME actual generator/assertion.
    fs.writeFileSync(
      f.file,
      corrected.replace(
        '"SampleTurboModule": {\n              "unstableRequiresMainQueueSetup": false',
        '"SampleTurboModule": {\n              "unstableRequiresMainQueueSetup": true'
      )
    )
    assert.equal(fs.readFileSync(f.file, 'utf8'), original)
    assert.throws(() => eligible(generated(f, 'reinstated')), { code: 'ERR_ASSERTION' })
    apply(f.app)
    eligible(generated(f, 'restored'))
    for (const name of apiFiles)
      assert.deepEqual(
        fs.readFileSync(path.join(f.module, name)),
        fs.readFileSync(path.join(rn, name))
      )
  })
})

test('unknown version is rejected without writes', async () => {
  const changed = original.replace('"version": "0.88.1"', '"version": "0.88.2"')
  await fixture(({ app, file }) => {
    assert.throws(() => apply(app), /expected react-native 0.88.1/)
    assert.equal(fs.readFileSync(file, 'utf8'), changed)
  }, changed)
})

test('unknown layout is rejected even with the original annotation present', async () => {
  const changed = original + '\n'
  await fixture(({ app, file }) => {
    assert.throws(() => apply(app), /unknown RN metadata layout/)
    assert.equal(fs.readFileSync(file, 'utf8'), changed)
  }, changed)
})

test('a linked external graph is refused without modifying its metadata', async () => {
  await fixture(async (foreign) => {
    await fixture(({ app, module }) => {
      fs.rmSync(module, { recursive: true })
      fs.symlinkSync(foreign.module, module)
      assert.throws(() => apply(app), /expected an app-owned RN graph/)
      assert.equal(fs.readFileSync(foreign.file, 'utf8'), original)
    })
  })
})

test('atomic replacement preserves mode and outside hardlink bytes, leaving no temporary entry', async () => {
  await fixture(async (foreign) => {
    await fixture((f) => {
      fs.chmodSync(foreign.file, 0o640)
      fs.unlinkSync(f.file)
      fs.linkSync(foreign.file, f.file)
      assert.equal(fs.statSync(f.file).ino, fs.statSync(foreign.file).ino)
      assert.equal(fs.statSync(f.file).nlink, 2)
      const entries = fs.readdirSync(f.module).sort()
      assert.equal(apply(f.app).did, 'patched')
      assert.equal(sha(fs.readFileSync(f.file)), PATCHED)
      assert.equal(fs.readFileSync(foreign.file, 'utf8'), original)
      assert.notEqual(fs.statSync(f.file).ino, fs.statSync(foreign.file).ino)
      assert.equal(fs.statSync(f.file).mode & 0o7777, 0o640)
      assert.deepEqual(fs.readdirSync(f.module).sort(), entries)
      assert.equal(apply(f.app).did, 'already patched')
    })
  })
})

test('app declares the plugin exactly once and the actual Expo iOS mod applies it', async () => {
  const config = require('../packages/mobile/app.json').expo
  assert.equal(
    config.plugins.filter((plugin) => plugin === './plugins/with-rn-eager-metadata').length,
    1
  )
  await fixture(async ({ app, file }) => {
    const registered = withRnEagerMetadata({ name: 'fixture', slug: 'fixture' })
    assert.equal(typeof registered.mods.ios.dangerous, 'function')
    await registered.mods.ios.dangerous({ ...registered, modRequest: { projectRoot: app } })
    assert.equal(
      sha(fs.readFileSync(file)),
      'fbc4960eab2d5fca3036b7fb9475dfa0e2129e08e2c60e39fc23bc705f585fb1'
    )
  })
})

test('actual app-provider codegen forwards the list; the internal plugin branch remains separate', async () => {
  await fixture(({ root }) => {
    const output = path.join(root, 'app-provider')
    generateAppDependencyProvider(output)
    const source = fs.readFileSync(path.join(output, 'RCTAppDependencyProvider.mm'), 'utf8')
    assert.match(source, /return RCTUnstableModulesRequiringMainQueueSetupProvider\.modules;/)
    assert.match(
      fs.readFileSync(path.join(output, 'ReactAppDependencyProvider.podspec'), 'utf8'),
      /s.dependency "ReactCodegen"/
    )
    const factory = fs.readFileSync(
      path.join(rn, 'Libraries/AppDelegate/RCTReactNativeFactory.mm'),
      'utf8'
    )
    assert.match(
      factory,
      /#if RN_DISABLE_OSS_PLUGIN_HEADER\s+return RCTTurboModulePluginUnstableModulesRequiringMainQueueSetup\(\);\s+#else\s+return self.delegate.dependencyProvider/
    )
    // A source assertion establishes this boundary, not a compiled/prebuilt branch.
    assert.match(
      factory,
      /RCTAppSetupUnstableModulesRequiringMainQueueSetup\(self.delegate.dependencyProvider\)/
    )
  })
})
