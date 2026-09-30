import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRootAsAsked } from './git-repo-root'

/**
 * The parent-repo notice compares the panel's path to git's resolved
 * toplevel. Through a symlink the two spell the same folder differently, and
 * the panel then reported every repo as nested inside itself.
 */
describe('repoRootAsAsked', () => {
  let base: string
  let real: string
  let link: string
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'clave-root-'))
    real = join(base, 'real')
    mkdirSync(real)
    link = join(base, 'link')
    symlinkSync(real, link)
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('answers in the asked spelling when the resolved toplevel is the asked folder', () => {
    expect(repoRootAsAsked(link, realpathSync.native(real))).toBe(link)
  })
  it('keeps git’s answer when the toplevel is a different folder', () => {
    const parent = realpathSync.native(base)
    expect(repoRootAsAsked(link, parent)).toBe(parent)
  })
  it('keeps git’s answer when the asked path cannot be resolved', () => {
    expect(repoRootAsAsked(join(base, 'missing'), '/somewhere')).toBe('/somewhere')
  })
  it('passes an empty toplevel through', () => {
    expect(repoRootAsAsked(link, '')).toBe('')
  })
})
