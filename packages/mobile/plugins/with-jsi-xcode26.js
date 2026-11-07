/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- a config plugin, plain JS read by expo prebuild */
// expo-modules-jsi 58.0.21 does not compile under Xcode 26.0.1 (Swift 6.2.0):
// `JavaScriptObject.swift` captures a `nonisolated(unsafe) let` pointer in a
// `JavaScriptActor.assumeIsolated` closure, which that compiler reports as
// `sending 'slot' risks causing data races` (expo/expo#52462, open on 29
// October 2026). The module's own fix for the same error elsewhere
// (expo/expo#51040, released in 58.0.9) wraps such a pointer in its
// `UncheckedSendable` struct; this plugin applies that one change to the
// one site the fix missed, at prebuild time, so a fresh clone builds with
// the Xcode this team has. It is idempotent, and it fails loudly when the
// module's code is neither the known original nor the patched form: that
// is the day the module shipped its own fix and this file is deleted.
const fs = require('node:fs')
const path = require('node:path')
const { withDangerousMod } = require('expo/config-plugins')

const BEFORE = `    nonisolated(unsafe) let slot = buffer.baseAddress!
    expo.emplaceUndefined(slot)
    defer {
      expo.destroyValues(slot, 1)
    }
    // The runtime can't be deallocated during a call on its JavaScript thread, so it's borrowed without
    // a retain.
    try runtime._withUnsafeGuaranteedRef { runtime in
      try JavaScriptActor.assumeIsolated {
        try encode(JavaScriptValue.Slot(slot), runtime)
      }
    }
    body(slot.pointee)`

const AFTER = `    // Wrapped as UncheckedSendable (expo/expo#51040's pattern), not nonisolated(unsafe):
    // Swift 6.2.0 (Xcode 26.0.1) reports the latter as "sending 'slot' risks causing data races".
    let slot = UncheckedSendable(buffer.baseAddress!)
    expo.emplaceUndefined(slot.value)
    defer {
      expo.destroyValues(slot.value, 1)
    }
    // The runtime can't be deallocated during a call on its JavaScript thread, so it's borrowed without
    // a retain.
    try runtime._withUnsafeGuaranteedRef { runtime in
      try JavaScriptActor.assumeIsolated {
        try encode(JavaScriptValue.Slot(slot.value), runtime)
      }
    }
    body(slot.value.pointee)`

/** Applies the change to the module's source; answers what it did. */
function applyJsiXcode26Fix(projectRoot) {
  const pkg = require.resolve('expo-modules-jsi/package.json', { paths: [projectRoot] })
  const file = path.join(
    path.dirname(pkg),
    'apple/Sources/ExpoModulesJSI/Runtime/Values/JavaScriptObject.swift'
  )
  const source = fs.readFileSync(file, 'utf8')
  if (source.includes(AFTER)) return { file, did: 'already patched' }
  if (!source.includes(BEFORE))
    throw new Error(
      `with-jsi-xcode26: ${file} holds neither the known original nor the patched code. The module changed (${require(pkg).version}): check whether it builds on this Xcode and delete this plugin.`
    )
  fs.writeFileSync(file, source.replace(BEFORE, AFTER))
  return { file, did: 'patched' }
}

module.exports = function withJsiXcode26(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const result = applyJsiXcode26Fix(config.modRequest.projectRoot)
      console.log(
        `» with-jsi-xcode26: ${result.did} ${path.relative(config.modRequest.projectRoot, result.file)}`
      )
      return config
    }
  ])
}
module.exports.applyJsiXcode26Fix = applyJsiXcode26Fix
