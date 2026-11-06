import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { repoKind } from './repo-index'

/** Discovery knows a linked worktree's source before any git command runs
 *  (PRDCT-4142): a repository's `.git` is a directory, a worktree's a file
 *  naming its gitdir inside the source. */
describe('repoKind', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'repo-kind-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('a repository of its own has no source', async () => {
    mkdirSync(path.join(root, 'app', '.git'), { recursive: true })
    await expect(repoKind(path.join(root, 'app'))).resolves.toEqual({ worktreeOf: null })
  })

  it('a linked worktree names the repository its gitdir lives in', async () => {
    mkdirSync(path.join(root, 'wt-lane'))
    writeFileSync(
      path.join(root, 'wt-lane', '.git'),
      `gitdir: ${path.join(root, 'app')}/.git/worktrees/wt-lane\n`
    )
    await expect(repoKind(path.join(root, 'wt-lane'))).resolves.toEqual({
      worktreeOf: path.join(root, 'app')
    })
  })

  it('a .git file that names no worktree gitdir is a repository with no source', async () => {
    mkdirSync(path.join(root, 'odd'))
    writeFileSync(path.join(root, 'odd', '.git'), 'gitdir: /somewhere/else/.git\n')
    await expect(repoKind(path.join(root, 'odd'))).resolves.toEqual({ worktreeOf: null })
  })

  it('a folder without .git is no repository', async () => {
    mkdirSync(path.join(root, 'plain'))
    await expect(repoKind(path.join(root, 'plain'))).resolves.toBeNull()
  })
})
