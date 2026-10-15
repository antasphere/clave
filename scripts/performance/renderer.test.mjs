// Keep the standalone Node checks on the repository's normal CI test rail.
import { test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('renderer benchmark checks and published evidence', () => {
  execFileSync(
    process.execPath,
    [
      '--test',
      'tests/performance/renderer-data.test.mjs',
      'tests/performance/renderer-cli.test.mjs',
      'tests/performance/renderer-artifacts.test.mjs'
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    }
  )
}, 35_000)
