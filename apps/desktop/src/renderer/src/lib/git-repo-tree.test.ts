/**
 * The spatial repo tree behind the multi-repo git panel: relativization
 * against the panel folder, single-child chain compaction, Finder ordering,
 * collapse-aware flattening, and the repoPaths roll-up sets the badges sum.
 */

import { describe, expect, it } from 'vitest'
import {
  buildRepoTree,
  flattenRepoTree,
  collectRepoTreeDirPaths,
  type RepoTreeDir,
  type RepoTreeNode
} from './git-repo-tree'

const WS = '/Users/u/ws'

function names(nodes: RepoTreeNode[]): string[] {
  return nodes.map((n) => `${n.type}:${n.name}`)
}

describe('buildRepoTree', () => {
  it('places repos under their real parent directories', () => {
    const tree = buildRepoTree(WS, [
      { name: 'app', path: `${WS}/labs/app` },
      { name: 'site', path: `${WS}/labs/site` },
      { name: 'brand', path: `${WS}/company/brand` }
    ])
    expect(names(tree)).toEqual(['dir:company', 'dir:labs'])
    const labs = tree[1] as RepoTreeDir
    expect(names(labs.children)).toEqual(['repo:app', 'repo:site'])
  })

  it('repos directly under the base stay a flat list — no dir rows', () => {
    const tree = buildRepoTree(WS, [
      { name: 'b', path: `${WS}/b` },
      { name: 'a', path: `${WS}/a` }
    ])
    expect(names(tree)).toEqual(['repo:a', 'repo:b'])
  })

  it('compacts single-child directory chains into one node', () => {
    const tree = buildRepoTree(WS, [
      { name: 'clave-app', path: `${WS}/labs/products/clave/clave-app` },
      { name: 'clave-os', path: `${WS}/labs/products/clave/clave-os` }
    ])
    // labs → products → clave all have one dir child: one compacted row.
    expect(names(tree)).toEqual(['dir:labs/products/clave'])
    const dir = tree[0] as RepoTreeDir
    expect(dir.path).toBe(`${WS}/labs/products/clave`)
    expect(names(dir.children)).toEqual(['repo:clave-app', 'repo:clave-os'])
  })

  it('stops compaction where the tree branches', () => {
    const tree = buildRepoTree(WS, [
      { name: 'hub', path: `${WS}/labs/products/ant/hub` },
      { name: 'clave-app', path: `${WS}/labs/products/clave/clave-app` },
      { name: 'sched', path: `${WS}/labs/services/sched` }
    ])
    // labs branches (products, services); products branches (ant, clave).
    expect(names(tree)).toEqual(['dir:labs'])
    const labs = tree[0] as RepoTreeDir
    expect(names(labs.children)).toEqual(['dir:products', 'dir:services'])
    const products = labs.children[0] as RepoTreeDir
    expect(names(products.children)).toEqual(['dir:ant', 'dir:clave'])
  })

  it('sorts each level alphabetically, dirs and repos interleaved (Finder order)', () => {
    const tree = buildRepoTree(WS, [
      { name: 'zeta', path: `${WS}/zeta` },
      { name: 'app', path: `${WS}/beta/app` },
      { name: 'alpha', path: `${WS}/alpha` }
    ])
    expect(names(tree)).toEqual(['repo:alpha', 'dir:beta', 'repo:zeta'])
  })

  it('rolls up repoPaths at every level of the subtree', () => {
    const tree = buildRepoTree(WS, [
      { name: 'a', path: `${WS}/labs/x/a` },
      { name: 'b', path: `${WS}/labs/y/b` },
      { name: 'c', path: `${WS}/labs/y/c` }
    ])
    const labs = tree[0] as RepoTreeDir
    expect(labs.repoPaths.sort()).toEqual([`${WS}/labs/x/a`, `${WS}/labs/y/b`, `${WS}/labs/y/c`])
    const y = labs.children.find((n) => n.name === 'y') as RepoTreeDir
    expect(y.repoPaths.sort()).toEqual([`${WS}/labs/y/b`, `${WS}/labs/y/c`])
  })

  it('a repo outside the base becomes a defensive top-level leaf', () => {
    const tree = buildRepoTree(WS, [{ name: 'stray', path: '/elsewhere/stray' }])
    expect(names(tree)).toEqual(['repo:stray'])
  })

  it('compacts chains below the top level too', () => {
    // Verifier gap M11: labs branches, but the chain under services must
    // still merge into one node.
    const tree = buildRepoTree(WS, [
      { name: 'hub', path: `${WS}/labs/ant/hub` },
      { name: 'sched', path: `${WS}/labs/services/deep/chain/sched` }
    ])
    const labs = tree[0] as RepoTreeDir
    expect(names(labs.children)).toEqual(['dir:ant', 'dir:services/deep/chain'])
    const chain = labs.children[1] as RepoTreeDir
    expect(chain.path).toBe(`${WS}/labs/services/deep/chain`)
    expect(names(chain.children)).toEqual(['repo:sched'])
  })

  it('a sibling folder sharing the base as a string prefix is NOT inside it', () => {
    // Verifier gap M10: /Users/u/ws-old shares the prefix "/Users/u/ws" as a
    // string but is a sibling on disk — it must become a top-level leaf, not
    // an invented "-old" directory.
    const tree = buildRepoTree(WS, [{ name: 'a', path: `${WS}-old/a` }])
    expect(names(tree)).toEqual(['repo:a'])
  })

  it('tolerates trailing and doubled separators on repo paths', () => {
    // Verifier gap M12: empty segments must never become directory nodes.
    const trailing = buildRepoTree(WS, [{ name: 'a', path: `${WS}/d/a/` }])
    expect(names(trailing)).toEqual(['dir:d'])
    expect(names((trailing[0] as RepoTreeDir).children)).toEqual(['repo:a'])
    const doubled = buildRepoTree(WS, [{ name: 'a', path: `${WS}//d/a` }])
    expect(names(doubled)).toEqual(['dir:d'])
    expect(names((doubled[0] as RepoTreeDir).children)).toEqual(['repo:a'])
  })

  it('tolerates a trailing slash on the base and a "/" base', () => {
    const slashed = buildRepoTree(`${WS}/`, [{ name: 'a', path: `${WS}/labs/a` }])
    expect(names(slashed)).toEqual(['dir:labs'])
    const rootBase = buildRepoTree('/', [{ name: 'a', path: '/labs/a' }])
    expect(names(rootBase)).toEqual(['dir:labs'])
  })
})

describe('flattenRepoTree', () => {
  const tree = buildRepoTree(WS, [
    { name: 'hub', path: `${WS}/labs/ant/hub` },
    { name: 'app', path: `${WS}/labs/clave/app` },
    { name: 'brand', path: `${WS}/company/brand` }
  ])

  it('expanded: every node appears with its depth', () => {
    const rows = flattenRepoTree(tree, new Set())
    expect(rows.map((r) => `${r.depth}:${r.node.type}:${r.node.name}`)).toEqual([
      '0:dir:company',
      '1:repo:brand',
      '0:dir:labs',
      '1:dir:ant',
      '2:repo:hub',
      '1:dir:clave',
      '2:repo:app'
    ])
  })

  it('a collapsed dir keeps its row but hides its subtree', () => {
    const rows = flattenRepoTree(tree, new Set([`${WS}/labs`]))
    expect(rows.map((r) => `${r.node.name}${r.collapsed ? '(collapsed)' : ''}`)).toEqual([
      'company',
      'brand',
      'labs(collapsed)'
    ])
  })
})

describe('collectRepoTreeDirPaths', () => {
  it('returns every directory path, compacted chains by their deepest path', () => {
    const tree = buildRepoTree(WS, [
      { name: 'a', path: `${WS}/labs/products/x/a` },
      { name: 'b', path: `${WS}/company/b` }
    ])
    expect(collectRepoTreeDirPaths(tree)).toEqual(
      new Set([`${WS}/company`, `${WS}/labs/products/x`])
    )
  })

  it('recurses into nested directories', () => {
    // Verifier gap M9: dirs below the top level must be collected too, or
    // collapse-all misses them.
    const tree = buildRepoTree(WS, [
      { name: 'r1', path: `${WS}/labs/a/r1` },
      { name: 'r2', path: `${WS}/labs/b/r2` }
    ])
    expect(collectRepoTreeDirPaths(tree)).toEqual(
      new Set([`${WS}/labs`, `${WS}/labs/a`, `${WS}/labs/b`])
    )
  })
})
