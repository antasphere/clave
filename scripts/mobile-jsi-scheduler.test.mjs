import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Keep the standalone Node suite in the normal root Vitest selection. The child
// tests use disposable source fixtures; they do not stage or run native code.
it('runs all scheduler patch and native-check staging regressions', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const output = execFileSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'scripts/mobile-jsi-scheduler.test.cjs'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        CLAVE_JSI_TEST_PACKAGE: fileURLToPath(
          new URL('../node_modules/expo-modules-jsi/package.json', import.meta.url)
        )
      }
    }
  )
  expect(output).toMatch(/^# tests 7$/m)
  expect(output).toMatch(/^# pass 7$/m)
  expect(output).toMatch(/^# fail 0$/m)
  expect(output).toMatch(/^# skipped 0$/m)
})
