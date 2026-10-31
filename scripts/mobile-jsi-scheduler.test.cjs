/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- standalone Node verification */
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { applyJsiSchedulerFix } = require('../packages/mobile/plugins/with-jsi-scheduler')

// This copies source to a disposable fixture. It never patches the input SDK.
const pkg = process.env.CLAVE_JSI_TEST_PACKAGE || require.resolve('expo-modules-jsi/package.json')
const input = path.join(
  path.dirname(pkg),
  'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift'
)
const original = readFileSync(input, 'utf8')
const sha = (source) => createHash('sha256').update(source).digest('hex')
assert.equal(sha(original), 'ae9d35493f078a76a312e5acd443eced2a5922c7bfb182ada6eaab1bb0563147')

function fixture(run, version = '58.0.21', source = original) {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-jsi-scheduler-'))
  const module = path.join(root, 'node_modules/expo-modules-jsi')
  const file = path.join(
    module,
    'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift'
  )
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(path.join(module, 'package.json'), JSON.stringify({ version }))
  writeFileSync(file, source)
  try {
    run(root, file)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('patches all four entry points once, preserving every other source byte', () => {
  fixture((root, file) => {
    assert.equal(applyJsiSchedulerFix(root).did, 'patched')
    const patched = readFileSync(file, 'utf8')
    assert.equal(sha(patched), '48491dcb17bc062c8ea47166e0abf19ff972befff4fa5f294048cbfd1fadf262')
    assert.equal((original.match(/Task\.immediate_polyfill/g) || []).length, 4)
    assert.equal(patched.includes('Task.immediate_polyfill'), false)
    assert.equal(
      patched,
      original
        .replaceAll('Task.immediate_polyfill {', 'Task(priority: .high) {')
        .replaceAll('Task.immediate_polyfill(priority: .high', 'Task(priority: .high')
    )
    assert.equal(applyJsiSchedulerFix(root).did, 'already patched')
    assert.equal(readFileSync(file, 'utf8'), patched)
  })
})

test('refuses an unrecognized version before any write', () => {
  fixture((root, file) => {
    assert.throws(() => applyJsiSchedulerFix(root), /expected expo-modules-jsi 58.0.21/)
    assert.equal(readFileSync(file, 'utf8'), original)
  }, '58.0.22')
})

test('refuses changed input even when all four callsites still match', () => {
  const changed = original + '\n// upstream change\n'
  fixture(
    (root, file) => {
      assert.throws(() => applyJsiSchedulerFix(root), /unknown scheduler source/)
      assert.equal(readFileSync(file, 'utf8'), changed)
    },
    '58.0.21',
    changed
  )
})

test('refuses a partial correction without completing or overwriting it', () => {
  const partial = original.replace('Task.immediate_polyfill {', 'Task(priority: .high) {')
  fixture(
    (root, file) => {
      assert.throws(() => applyJsiSchedulerFix(root), /unknown scheduler source/)
      assert.equal(readFileSync(file, 'utf8'), partial)
    },
    '58.0.21',
    partial
  )
})

// Staging fixtures contain reviewed SDK text and empty framework directories.
// They exercise filesystem guards only, never a native tool or binary.
function stagingFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-jsi-stage-'))
  const sdk = path.join(root, 'node_modules/expo-modules-jsi')
  const apple = path.join(sdk, 'apple')
  const core = path.join(
    root,
    'packages/mobile/ios/Pods/ExpoModulesCore/ExpoModulesCore.xcframework'
  )
  const records =
    'node_modules/expo-notifications/ios/ExpoNotifications/Notifications/TriggerRecords.swift'
  const suite = 'packages/mobile/native-checks/ClaveSchedulerAffinityTests.swift'
  const copies = [
    ['apple/Package.swift', path.join(apple, 'Package.swift')],
    ['apple/scripts/build-xcframework.sh', path.join(apple, 'scripts/build-xcframework.sh')],
    [
      'apple/Tests/Support/TestRuntimeScheduler.swift',
      path.join(apple, 'Tests/Support/TestRuntimeScheduler.swift')
    ],
    [
      'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift',
      path.join(apple, 'Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift')
    ]
  ]
  for (const [source, destination] of copies) {
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, readFileSync(path.join(path.dirname(pkg), source)))
  }
  for (const [destination, source] of [
    [records, path.join(path.dirname(pkg), '..', records.slice('node_modules/'.length))],
    [suite, path.join(__dirname, '..', suite)]
  ]) {
    mkdirSync(path.dirname(path.join(root, destination)), { recursive: true })
    writeFileSync(path.join(root, destination), readFileSync(source))
  }
  mkdirSync(core, { recursive: true })
  writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ version: '58.0.21' }))
  try {
    run({ root, sdk, apple, core, records: path.join(root, records) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Require lazily so an unsafe import is a failing test, not staging in this repo.
function prepare(...args) {
  return require('./prepare-mobile-jsi-native-check.cjs').prepareNativeCheck(...args)
}

test('staging is idempotent and switches only exact original/patched scheduler bytes', () => {
  stagingFixture(({ root, apple, core }) => {
    const first = prepare(root, 'original')
    assert.equal(first.runtime, 'NOT RUN')
    const scheduler = path.join(
      apple,
      'Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift'
    )
    assert.equal(readFileSync(scheduler, 'utf8'), original)
    const manifest = readFileSync(path.join(apple, 'Package.swift'), 'utf8')
    assert.match(manifest, /"ReactNativeDependencies", "ExpoModulesCore"/)
    assert.match(
      readFileSync(path.join(apple, 'scripts/build-xcframework.sh'), 'utf8'),
      /xcodebuild -jobs 2 \\/
    )
    assert.equal(
      realpathSync(path.join(apple, '.test-frameworks/ExpoModulesCore.xcframework')),
      realpathSync(core)
    )
    assert.deepEqual(prepare(root, 'original'), first)
    const patched = prepare(root, 'patched')
    assert.equal(
      patched.schedulerSHA256,
      '48491dcb17bc062c8ea47166e0abf19ff972befff4fa5f294048cbfd1fadf262'
    )
    assert.equal(readFileSync(path.join(apple, 'Package.swift'), 'utf8'), manifest)
    assert.deepEqual(prepare(root, 'original'), first)
    assert.equal(readFileSync(scheduler, 'utf8'), original)
  })
})

test('staging refuses unknown inputs before any output write', () => {
  for (const target of ['manifest', 'records', 'scheduler', 'build', 'support', 'variant']) {
    stagingFixture(({ root, apple, records }) => {
      const file = {
        manifest: path.join(apple, 'Package.swift'),
        records,
        scheduler: path.join(
          apple,
          'Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift'
        ),
        build: path.join(apple, 'scripts/build-xcframework.sh'),
        support: path.join(apple, 'Tests/Support/TestRuntimeScheduler.swift')
      }[target]
      if (file) writeFileSync(file, readFileSync(file, 'utf8') + '\n// changed\n')
      const before = readFileSync(path.join(apple, 'Package.swift'), 'utf8')
      assert.throws(
        () => prepare(root, target === 'variant' ? 'typo' : 'patched'),
        /Unrecognized|Choose original/
      )
      assert.equal(readFileSync(path.join(apple, 'Package.swift'), 'utf8'), before)
      assert.equal(existsSync(path.join(apple, '.test-frameworks')), false)
      assert.equal(existsSync(path.join(apple, 'Tests/ClaveSchedulerAffinityTests.swift')), false)
    })
  }
})

test('staging refuses foreign output symlinks before any write', () => {
  for (const target of [
    '.test-frameworks',
    'Tests/ClaveSchedulerAffinityTests.swift',
    'Tests/ClaveNotificationTriggerRecords.swift'
  ]) {
    stagingFixture(({ root, apple }) => {
      const foreign = mkdtempSync(path.join(tmpdir(), 'clave-jsi-foreign-'))
      try {
        const sentinel = path.join(foreign, 'untouched')
        writeFileSync(sentinel, 'foreign')
        symlinkSync(target === '.test-frameworks' ? foreign : sentinel, path.join(apple, target))
        const before = readFileSync(path.join(apple, 'Package.swift'), 'utf8')
        assert.throws(() => prepare(root, 'patched'), /Unexpected/)
        assert.equal(readFileSync(sentinel, 'utf8'), 'foreign')
        assert.equal(readFileSync(path.join(apple, 'Package.swift'), 'utf8'), before)
      } finally {
        rmSync(foreign, { recursive: true, force: true })
      }
    })
  }
})
