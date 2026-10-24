import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { ClaveApi } from './api'
import { ServerEvent } from './events'
import {
  DiscoverGitRepos,
  GitDiff,
  GitLog,
  GitOperationFailed,
  GitStatusResult,
  gitGroup
} from './git'

/**
 * The git domain's wire shapes (wave wcs1023, lane C, #242): the status as
 * the Mac's implementation answers it survives the wire, a GET's flags and
 * numbers decode from the strings a URL carries, and the two events are
 * members of `ServerEvent`.
 */
describe('the git contract', () => {
  it('carries a status with its worktree reading and back', () => {
    const status = {
      isRepo: true,
      branch: 'lane',
      ahead: 1,
      behind: 0,
      hasUpstream: true,
      files: [{ path: 'src/a.ts', status: 'modified', staged: false }],
      repoRoot: '/srv/repo',
      worktree: {
        of: '/srv/main',
        base: 'origin/dev',
        baseLabel: 'dev',
        ahead: 2,
        behind: 1,
        merged: false,
        createdAt: 1700000000000,
        lastCommit: { at: 1700000001000, subject: 'feat: x' }
      }
    }
    const decoded = Schema.decodeUnknownSync(GitStatusResult)(status)
    expect(Schema.encodeSync(GitStatusResult)(decoded)).toEqual(status)
    const bare = { ...status, worktree: undefined }
    delete (bare as { worktree?: unknown }).worktree
    expect(Schema.decodeUnknownSync(GitStatusResult)(bare)).toEqual(bare)
  })

  it('decodes a GET query’s flags and numbers from their string form', () => {
    expect(
      Schema.decodeUnknownSync(DiscoverGitRepos.payload)({ cwd: '/srv/repo', force: 'true' })
    ).toEqual({ cwd: '/srv/repo', force: true })
    expect(Schema.decodeUnknownSync(DiscoverGitRepos.payload)({ cwd: '/srv/repo' })).toEqual({
      cwd: '/srv/repo'
    })
    expect(
      Schema.decodeUnknownSync(GitDiff.payload)({
        cwd: '/srv/repo',
        filePath: 'a.ts',
        staged: 'false',
        isUntracked: 'true'
      })
    ).toEqual({ cwd: '/srv/repo', filePath: 'a.ts', staged: false, isUntracked: true })
    expect(Schema.decodeUnknownSync(GitLog.payload)({ cwd: '/srv/repo', maxCount: '50' })).toEqual({
      cwd: '/srv/repo',
      maxCount: 50
    })
    expect(() =>
      Schema.decodeUnknownSync(GitLog.payload)({ cwd: '/srv/repo', maxCount: '0' })
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(GitLog.payload)({ cwd: '' })).toThrow()
  })

  it('is a group of the shared API, and its events are members of ServerEvent', () => {
    expect(ClaveApi.groups).toHaveProperty('git')
    expect(gitGroup.identifier).toBe('git')
    const changed = Schema.decodeUnknownSync(ServerEvent)({
      _tag: 'git.repos_changed',
      repos: ['/srv/repo']
    })
    expect(changed).toEqual({ _tag: 'git.repos_changed', repos: ['/srv/repo'] })
    const progress = Schema.decodeUnknownSync(ServerEvent)({
      _tag: 'git.batch_progress',
      op: 'sync',
      phase: 'generating',
      repoPath: '/srv/repo',
      repoName: 'repo',
      done: 0,
      total: 1,
      batchId: 'mac-1:3'
    })
    expect(progress).toMatchObject({
      _tag: 'git.batch_progress',
      op: 'sync',
      total: 1,
      batchId: 'mac-1:3'
    })
  })

  it('declares the failure git’s own sentence travels in', () => {
    const failed = new GitOperationFailed({ message: 'nothing to commit, working tree clean' })
    expect(Schema.encodeSync(GitOperationFailed)(failed)).toMatchObject({
      _tag: 'GitOperationFailed',
      message: 'nothing to commit, working tree clean'
    })
  })
})
