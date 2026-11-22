import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// The entry runs as a process of its own and starts a server on import, so
// its one line of wiring is held by its text; the rule is antigravity-setting.test.ts's.
it('the server entry is told where the app keeps the Antigravity setting', () => {
  const entry = readFileSync(join(__dirname, 'server-entry.ts'), 'utf8')
  expect(entry).toMatch(/readAntigravitySettingFrom\(shellDataDir\)/)
})
