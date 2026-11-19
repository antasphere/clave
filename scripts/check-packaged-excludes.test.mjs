import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { forbiddenEntries } from './check-packaged-excludes.mjs'

describe('what the packaged app must leave out (issue #407)', () => {
  it('flags the tests folder and everything under it, and nothing else', () => {
    expect(
      forbiddenEntries([
        '/out/main/index.js',
        '/tests',
        '/tests/e2e/fixtures/relay/relay.ts',
        '/testsuite.js',
        '/node_modules/foo/tests/a.js'
      ])
    ).toEqual(['/tests', '/tests/e2e/fixtures/relay/relay.ts'])
  })
  it('is excluded by electron-builder’s files patterns', () => {
    const yml = readFileSync(path.join(import.meta.dirname, '..', 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^ {2}- '!tests'$/m)
  })
})
