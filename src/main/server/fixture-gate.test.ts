import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The test fixture route runs code it is sent, so the two places that turn
 * it on in a real process must pass the test flag and nothing else:
 * Electron main (`src/main/index.ts`, the in-process server) and the
 * standalone entry (`src/main/server-entry.ts`). The standalone entry is
 * proven at process level (`scripts/server-process.test.mjs`: no flag, 404);
 * the app cannot be launched without the flag by the suite (the flag is
 * what keeps a test window off the screen), so its gate is held here at the
 * source and at the built bundle: `testFixtures` is set from
 * `TEST_NO_ACTIVATE` and from nothing else, and `TEST_NO_ACTIVATE` is the
 * `--test-no-activate` argument, not an environment variable or a file.
 */
const root = join(__dirname, '..', '..', '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

/** Every `testFixtures:` assignment in a text, with what it is set to. */
const assignments = (text: string): string[] =>
  [...text.matchAll(/testFixtures:\s*([^,}\n]+)/g)].map((m) => m[1].trim())

describe('the fixture route is turned on by the test flag and nothing else', () => {
  it('in the source of the app and of the standalone entry', () => {
    for (const file of ['src/main/index.ts', 'src/main/server-entry.ts']) {
      const found = assignments(read(file))
      expect(found, file).toEqual(['TEST_NO_ACTIVATE'])
    }
    // The flag is the launch argument, read once; nothing else sets it.
    const testMode = read('src/main/test-mode.ts')
    expect(testMode).toMatch(
      /export const TEST_NO_ACTIVATE = process\.argv\.includes\('--test-no-activate'\)/
    )
    expect(testMode).not.toMatch(/process\.env/)
  })
  it('in the built main bundle, when there is one', () => {
    const bundle = join(root, 'out', 'main', 'index.js')
    if (!existsSync(bundle)) return
    const text = readFileSync(bundle, 'utf8')
    // The server package passes the option through (`options.testFixtures`);
    // the app's own assignment is the flag, and only it.
    const own = assignments(text).filter((value) => !value.startsWith('options.'))
    expect(own).toEqual(['TEST_NO_ACTIVATE'])
    expect(text).toMatch(/const TEST_NO_ACTIVATE = process\.argv\.includes\("--test-no-activate"\)/)
  })
})
