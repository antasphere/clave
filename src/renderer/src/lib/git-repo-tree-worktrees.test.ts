/**
 * Worktrees in the spatial repo tree (PRDCT-2356): a worktree hangs under the
 * repo it was cut from rather than at its place on disk, the repos stay
 * alphabetical and each repo's worktrees follow it alphabetically, a worktree
 * whose source is not in the list is an ordinary repo, and a folded folder's
 * roll-up counts the worktrees shown under its repos.
 */

import { describe, expect, it } from 'vitest'
import {
  buildRepoTree,
  flattenRepoTree,
  orderWithWorktrees,
  worktreeSourcePath,
  type RepoTreeDir,
  type RepoTreeLeaf,
  type RepoTreeNode
} from './git-repo-tree'

const WS = '/Users/u/ws'

function names(nodes: RepoTreeNode[]): string[] {
  return nodes.map((n) => `${n.type}:${n.name}`)
}

describe('buildRepoTree with worktrees', () => {
  const repos = [
    { name: 'wt-b', path: `${WS}/labs/wt-b`, worktreeOf: `${WS}/labs/app` },
    { name: 'app', path: `${WS}/labs/app` },
    { name: 'wt-a', path: `${WS}/labs/wt-a`, worktreeOf: `${WS}/labs/app` },
    { name: 'site', path: `${WS}/labs/site` },
    // Sits in another folder entirely; still hangs under its source.
    { name: 'wt-elsewhere', path: `${WS}/scratch/wt-elsewhere`, worktreeOf: `${WS}/labs/app` },
    // Its source is outside the list: a repo row at its real place.
    { name: 'wt-orphan', path: `${WS}/labs/wt-orphan`, worktreeOf: '/elsewhere/main' }
  ]

  it('hangs each worktree under its source, alphabetical, and keeps the repos alphabetical', () => {
    const tree = buildRepoTree(WS, repos)
    expect(names(tree)).toEqual(['dir:labs'])
    const labs = tree[0] as RepoTreeDir
    expect(names(labs.children)).toEqual(['repo:app', 'repo:site', 'repo:wt-orphan'])
    const app = labs.children[0] as RepoTreeLeaf
    expect(app.worktrees.map((w) => w.name)).toEqual(['wt-a', 'wt-b', 'wt-elsewhere'])
    expect(app.worktrees.every((w) => w.of === `${WS}/labs/app`)).toBe(true)
    expect((labs.children[1] as RepoTreeLeaf).worktrees).toEqual([])
  })

  it('does not put a worktree in the folder it sits in', () => {
    const tree = buildRepoTree(WS, repos)
    // `scratch/` holds only a worktree that hangs elsewhere, so no dir row for it.
    expect(names(tree)).not.toContain('dir:scratch')
  })

  it('rolls the worktrees up under the folders above their SOURCE', () => {
    const tree = buildRepoTree(WS, repos)
    const labs = tree[0] as RepoTreeDir
    expect(labs.repoPaths).toContain(`${WS}/scratch/wt-elsewhere`)
    expect(labs.repoPaths).toContain(`${WS}/labs/wt-a`)
  })

  it('flattens a repo, then its worktrees at the same depth, the last one flagged', () => {
    const rows = flattenRepoTree(buildRepoTree(WS, repos), new Set())
    const kinds = rows.map((r) => `${r.node.type}:${r.node.name}@${r.depth}${r.last ? '!' : ''}`)
    expect(kinds).toEqual([
      'dir:labs@0',
      'repo:app@1',
      'worktree:wt-a@1',
      'worktree:wt-b@1',
      'worktree:wt-elsewhere@1!',
      'repo:site@1',
      'repo:wt-orphan@1'
    ])
  })

  it('hides the worktrees with their repo when the folder is folded', () => {
    const rows = flattenRepoTree(buildRepoTree(WS, repos), new Set([`${WS}/labs`]))
    expect(rows.map((r) => r.node.type)).toEqual(['dir'])
  })

  it('ignores a worktree pointing at itself', () => {
    const tree = buildRepoTree(WS, [{ name: 'self', path: `${WS}/self`, worktreeOf: `${WS}/self` }])
    expect(names(tree)).toEqual(['repo:self'])
  })
})

describe('worktrees by date (PRDCT-2360)', () => {
  const app = { name: 'app', path: `${WS}/app` }
  // Names in one order, dates in the other.
  const repos = [
    app,
    { name: 'wt-a', path: `${WS}/wt-a`, worktreeOf: app.path, createdAt: 1000 },
    { name: 'wt-b', path: `${WS}/wt-b`, worktreeOf: app.path, createdAt: 3000 },
    { name: 'wt-c', path: `${WS}/wt-c`, worktreeOf: app.path, createdAt: 2000 },
    { name: 'wt-undated', path: `${WS}/wt-undated`, worktreeOf: app.path, createdAt: null },
    { name: 'wt-same-1', path: `${WS}/wt-same-1`, worktreeOf: app.path, createdAt: 3000 }
  ]

  it('runs newest first, ties by name, the undated last', () => {
    const tree = buildRepoTree(WS, repos)
    const leaf = tree[0] as RepoTreeLeaf
    expect(leaf.worktrees.map((w) => w.name)).toEqual(['wt-b', 'wt-same-1', 'wt-c', 'wt-a', 'wt-undated'])
  })

  it('the flat order agrees', () => {
    const rows = orderWithWorktrees(repos)
    expect(rows.map((r) => r.repo.name)).toEqual(['app', 'wt-b', 'wt-same-1', 'wt-c', 'wt-a', 'wt-undated'])
    expect(rows[rows.length - 1].last).toBe(true)
  })
})

describe('worktreeSourcePath', () => {
  // Discovery walked the root through a symlink; git names the source resolved.
  const repos = [
    { path: '/tmp/ws/app', repoRoot: '/private/tmp/ws/app' },
    { path: '/tmp/ws/wt', repoRoot: '/private/tmp/ws/wt' }
  ]

  it('swaps the resolved source for the path discovery spelled', () => {
    expect(worktreeSourcePath('/private/tmp/ws/app', repos)).toBe('/tmp/ws/app')
  })

  it('accepts the walked path itself, with or without a trailing slash', () => {
    expect(worktreeSourcePath('/tmp/ws/app', repos)).toBe('/tmp/ws/app')
    expect(worktreeSourcePath('/private/tmp/ws/app/', repos)).toBe('/tmp/ws/app')
  })

  it('leaves a source that is no repo of the list as it is, and nothing as null', () => {
    expect(worktreeSourcePath('/elsewhere/main', repos)).toBe('/elsewhere/main')
    expect(worktreeSourcePath(null, repos)).toBeNull()
    expect(worktreeSourcePath(undefined, repos)).toBeNull()
  })

  it('so a worktree under a symlinked root still hangs under its source', () => {
    const tree = buildRepoTree('/tmp/ws', [
      { name: 'app', path: '/tmp/ws/app' },
      { name: 'wt', path: '/tmp/ws/wt', worktreeOf: worktreeSourcePath('/private/tmp/ws/app', repos) }
    ])
    expect(names(tree)).toEqual(['repo:app'])
    expect((tree[0] as RepoTreeLeaf).worktrees.map((w) => w.name)).toEqual(['wt'])
  })
})

describe('orderWithWorktrees', () => {
  it('keeps the repos in their order and puts each one’s worktrees after it', () => {
    const rows = orderWithWorktrees([
      { name: 'b', path: '/b' },
      { name: 'wt-b2', path: '/wt-b2', worktreeOf: '/b' },
      { name: 'a', path: '/a' },
      { name: 'wt-b1', path: '/wt-b1', worktreeOf: '/b' },
      { name: 'wt-x', path: '/wt-x', worktreeOf: '/nowhere' }
    ])
    expect(rows.map((r) => `${r.repo.name}${r.worktree ? '~' : ''}${r.last ? '!' : ''}`)).toEqual([
      'b',
      'wt-b1~',
      'wt-b2~!',
      'a',
      'wt-x'
    ])
  })
})
