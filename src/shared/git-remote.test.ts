import { expect, it } from 'vitest'
import { normalizeGitRemote } from './git-remote'

it('reads the same repository from every URL form git accepts', () => {
  const expected = 'github.com/acme/shop'
  for (const url of [
    'git@github.com:acme/shop.git',
    'git@github.com:acme/shop',
    'https://github.com/acme/shop.git',
    'https://github.com/acme/shop',
    'https://user@github.com/acme/shop.git/',
    'ssh://git@github.com/acme/shop.git',
    'ssh://git@github.com:22/acme/shop.git',
    '  GitHub.com:Acme/Shop.GIT  '
  ])
    expect(normalizeGitRemote(url), url).toBe(expected)
})

it('keeps a remote on the disk as its path, without .git', () => {
  expect(normalizeGitRemote('/tmp/fleet/origin.git')).toBe('/tmp/fleet/origin')
  expect(normalizeGitRemote('file:///tmp/fleet/origin.git/')).toBe('/tmp/fleet/origin')
  expect(normalizeGitRemote('../origin.git')).toBe('../origin')
})

it('tells two repositories apart and answers null for nothing', () => {
  expect(normalizeGitRemote('git@github.com:acme/shop.git')).not.toBe(
    normalizeGitRemote('git@github.com:acme/shop-docs.git')
  )
  expect(normalizeGitRemote('git@github.com:acme/shop.git')).not.toBe(
    normalizeGitRemote('git@gitlab.com:acme/shop.git')
  )
  expect(normalizeGitRemote(null)).toBeNull()
  expect(normalizeGitRemote(undefined)).toBeNull()
  expect(normalizeGitRemote('   ')).toBeNull()
  expect(normalizeGitRemote('https://')).toBeNull()
})
