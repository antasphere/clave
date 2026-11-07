/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- standalone Node verification */
// Source staging only. No install, prebuild, compiler, simulator or subprocess.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const digest = (text) => createHash('sha256').update(text).digest('hex')
const ORIGINAL = 'ae9d35493f078a76a312e5acd443eced2a5922c7bfb182ada6eaab1bb0563147'
const PATCHED = '48491dcb17bc062c8ea47166e0abf19ff972befff4fa5f294048cbfd1fadf262'

function prepareNativeCheck(worktree, variant) {
  if (!['original', 'patched'].includes(variant))
    throw new Error('Choose original or patched explicitly')
  const root = fs.realpathSync(worktree)
  function own(file) {
    const real = fs.realpathSync(file)
    if (!real.startsWith(root + path.sep))
      throw new Error('Native check input escapes task worktree')
    return real
  }
  function read(file, expected) {
    const source = fs.readFileSync(own(file), 'utf8')
    if (!expected.includes(digest(source)))
      throw new Error(`Unrecognized native check input: ${file}`)
    return source
  }
  function output(file, expected) {
    // Existing generated files must match this suite exactly. Never follow an
    // output symlink, including a dangling one or a link to an internal file.
    let stat
    try {
      stat = fs.lstatSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (stat && (!stat.isFile() || fs.readFileSync(file, 'utf8') !== expected))
      throw new Error(`Unexpected existing native check output: ${file}`)
  }
  const sdk = own(path.join(root, 'node_modules/expo-modules-jsi'))
  if (JSON.parse(fs.readFileSync(own(path.join(sdk, 'package.json')))).version !== '58.0.21')
    throw new Error('Native check requires expo-modules-jsi 58.0.21')
  const apple = own(path.join(sdk, 'apple'))
  const core = own(
    path.join(root, 'packages/mobile/ios/Pods/ExpoModulesCore/ExpoModulesCore.xcframework')
  )
  if (!fs.statSync(core).isDirectory()) throw new Error('Missing Core test framework')
  const records = read(
    path.join(
      root,
      'node_modules/expo-notifications/ios/ExpoNotifications/Notifications/TriggerRecords.swift'
    ),
    ['b586edcd58fd1397f061b6d0323697c8aee9d6c5affdd2c7f12cd065a1d266d2']
  )
  const manifest = own(path.join(apple, 'Package.swift'))
  const originalManifestHash = '79f046c9cf2a9045bf6d6b61f4628a4dfd35693d4d102394e30c145bc03490c4'
  // The auto-generated package scheme compiles every test target even with
  // -only-testing. Benchmarks has no incoming Tests/production dependency.
  // Omit exactly that target in BOTH variants, retaining every test and flag.
  const benchmarkTarget =
    '    // Benchmarks are opt-in: their suites are gated on the `EXPO_BENCHMARK` environment\n    // variable, so regular test runs build them but skip every suite. Run `pnpm benchmark`\n    // to execute them in the Release configuration.\n    .testTarget(\n      name: "Benchmarks",\n      dependencies: testFrameworks.dependencies,\n      path: "Benchmarks",\n    ),\n'
  const tail = '  ] + testFrameworks.binaryTargets,'
  const manifestSource = fs.readFileSync(manifest, 'utf8')
  const withBenchmarks = manifestSource.includes(benchmarkTarget)
    ? manifestSource
    : manifestSource.replace(tail, benchmarkTarget + tail)
  const originalManifest = withBenchmarks.replace(
    'let names = ["React", "hermesvm", "ReactNativeDependencies", "ExpoModulesCore"]',
    'let names = ["React", "hermesvm", "ReactNativeDependencies"]'
  )
  if (digest(originalManifest) !== originalManifestHash)
    throw new Error('Unrecognized native check input: manifest')
  const stagedManifest = originalManifest
    .replace(
      'let names = ["React", "hermesvm", "ReactNativeDependencies"]',
      'let names = ["React", "hermesvm", "ReactNativeDependencies", "ExpoModulesCore"]'
    )
    .replace(benchmarkTarget, '')
  const build = own(path.join(apple, 'scripts/build-xcframework.sh'))
  const buildSource = fs.readFileSync(build, 'utf8')
  const originalBuild = buildSource.replace('    xcodebuild -jobs 2 ', '    xcodebuild ')
  if (digest(originalBuild) !== '2551dc6457f370cf9fefe184f030ddf85d2899f3bcc0eef4d6ef135b04f25678')
    throw new Error('Unrecognized native check input: build script')
  const stagedBuild = originalBuild.replace('    xcodebuild ', '    xcodebuild -jobs 2 ')
  const tests = own(path.join(apple, 'Tests'))
  read(path.join(tests, 'Support/TestRuntimeScheduler.swift'), [
    '6c61363c6626353806747e5e0df06b11358ac8bcd3b3bc740438e8151bcfc9e2'
  ])
  const scheduler = own(
    path.join(apple, 'Sources/ExpoModulesJSI/Runtime/JavaScriptRuntimeScheduler.swift')
  )
  const schedulerSource = read(scheduler, [ORIGINAL, PATCHED])
  const originalScheduler =
    digest(schedulerSource) === ORIGINAL
      ? schedulerSource
      : schedulerSource
          .replace('Task(priority: .high) {', 'Task.immediate_polyfill {')
          .replaceAll('Task(priority: .high', 'Task.immediate_polyfill(priority: .high')
  if (digest(originalScheduler) !== ORIGINAL)
    throw new Error('Invalid original scheduler reconstruction')
  const selectedScheduler =
    variant === 'original'
      ? originalScheduler
      : originalScheduler
          .replaceAll('Task.immediate_polyfill {', 'Task(priority: .high) {')
          .replaceAll('Task.immediate_polyfill(priority: .high', 'Task(priority: .high')
  if (digest(selectedScheduler) !== (variant === 'original' ? ORIGINAL : PATCHED))
    throw new Error('Invalid selected scheduler')
  const check = fs.readFileSync(
    own(path.join(root, 'packages/mobile/native-checks/ClaveSchedulerAffinityTests.swift')),
    'utf8'
  )
  const stagedRecords = 'import UserNotifications\n' + records
  const frameworks = path.join(apple, '.test-frameworks')
  // Disallow aliasing the entire output directory before inspecting its child.
  let frameworkStat
  try {
    frameworkStat = fs.lstatSync(frameworks)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (frameworkStat && (!frameworkStat.isDirectory() || own(frameworks) !== frameworks))
    throw new Error('Unexpected native check framework directory')
  const link = path.join(frameworks, 'ExpoModulesCore.xcframework')
  let linkStat
  try {
    linkStat = fs.lstatSync(link)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (linkStat && (!linkStat.isSymbolicLink() || own(link) !== core))
    throw new Error('Unexpected native check Core framework link')
  const testFile = path.join(tests, 'ClaveSchedulerAffinityTests.swift')
  const recordsFile = path.join(tests, 'ClaveNotificationTriggerRecords.swift')
  output(testFile, check)
  output(recordsFile, stagedRecords)
  // All version, text and ownership checks precede the first write. Partial
  // filesystem failure may leave staging incomplete; re-run the same variant.
  fs.mkdirSync(frameworks, { recursive: true })
  if (!linkStat) fs.symlinkSync(core, link)
  for (const [file, text] of [
    [manifest, stagedManifest],
    [build, stagedBuild],
    [scheduler, selectedScheduler],
    [testFile, check],
    [recordsFile, stagedRecords]
  ])
    fs.writeFileSync(file, text)
  return {
    staged: true,
    runtime: 'NOT RUN',
    variant,
    schedulerSHA256: digest(selectedScheduler),
    sourceSHA256: digest(check),
    recordsSHA256: digest(records),
    manifestSHA256: digest(stagedManifest),
    nestedBuildScriptSHA256: digest(stagedBuild),
    maxNestedBuildJobs: 2
  }
}

module.exports = { prepareNativeCheck }
if (require.main === module) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/prepare-mobile-jsi-native-check.cjs original|patched')
  console.log(JSON.stringify(prepareNativeCheck(path.join(__dirname, '..'), process.argv[2])))
}
