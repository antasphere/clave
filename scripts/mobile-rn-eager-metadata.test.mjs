/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone Node verification */
import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { applyRnEagerMetadataFix } = require('../packages/mobile/plugins/with-rn-eager-metadata')

function run(env = process.env) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', 'scripts/mobile-rn-eager-metadata.test.cjs'],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      timeout: 10000,
      env
    }
  )
  const output = result.stdout ?? ''
  expect(result.status, output + (result.stderr ?? '') + (result.error ?? '')).toBe(0)
  expect(output).toMatch(/^# tests 7$/m)
  expect(output).toMatch(/^# pass 7$/m)
  expect(output).toMatch(/^# fail 0$/m)
  expect(output).toMatch(/^# skipped 0$/m)
}

// Normal root test lane, both before and after the app's build-time correction.
// No SDK/native compilation, installs or runtime launches.
it('checks the actual-codegen suite with original and post-prebuild owned metadata', () => {
  run()
  const root = mkdtempSync(path.join(tmpdir(), 'clave-rn-eager-loader-'))
  const app = path.join(root, 'packages/mobile')
  const pkg = path.join(root, 'node_modules/react-native/package.json')
  try {
    mkdirSync(app, { recursive: true })
    mkdirSync(path.dirname(pkg), { recursive: true })
    copyFileSync(
      process.env.CLAVE_RN_TEST_PACKAGE || require.resolve('react-native/package.json'),
      pkg
    )
    applyRnEagerMetadataFix(app)
    expect(applyRnEagerMetadataFix(app).did).toBe('already patched')
    const env = { ...process.env, CLAVE_RN_TEST_PACKAGE: pkg }
    run(env)
    // Known patched bytes are supported; even whitespace drift is not.
    writeFileSync(pkg, readFileSync(pkg, 'utf8') + '\n')
    expect(() => run(env)).toThrow(/expected exact original or patched RN metadata/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
