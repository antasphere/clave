import { describe, it, expect } from 'vitest'
import { summarizePull, shortReason, repoName } from './pull-summary'

describe('summarizePull', () => {
  it('counts the repos pulled and up to date, with no failures', () => {
    const s = summarizePull([
      { repoPath: '/w/a', pulled: true, error: null },
      { repoPath: '/w/b', pulled: false, error: null }
    ])
    expect(s).toEqual({ message: '1 pulled, 1 up to date', failures: [] })
  })

  it('names each failed repo in the line, with its reason kept for the tooltip', () => {
    const s = summarizePull([
      { repoPath: '/w/a', pulled: true, error: null },
      {
        repoPath: '/w/tools/crm',
        pulled: false,
        error: 'error: could not apply 1a2b3c... local\nhint: Resolve all conflicts'
      }
    ])
    expect(s.message).toBe('1 pulled, 1 failed: crm')
    expect(s.failures).toEqual([{ name: 'crm', reason: 'could not apply 1a2b3c... local' }])
  })

  it('names three failed repos and counts the rest', () => {
    const s = summarizePull(
      ['a', 'b', 'c', 'd', 'e'].map((n) => ({ repoPath: `/w/${n}`, pulled: false, error: 'boom' }))
    )
    expect(s.message).toBe('5 failed: a, b, c +2 more')
    expect(s.failures).toHaveLength(5)
  })
})

describe('shortReason', () => {
  it("names the conflict of a rebase, not git's progress line before it", () => {
    // simple-git's message for a stopped `rebase --autostash @{u}`, verbatim.
    const rebase =
      'Auto-merging f\nCONFLICT (add/add): Merge conflict in f\nRebasing (1/1)\rerror: could not apply 170ef80... local\nhint: Resolve all conflicts manually\nCould not apply 170ef80... # local\n'
    expect(shortReason(rebase)).toBe('CONFLICT (add/add): Merge conflict in f')
  })
  it('names the fatal line of a refused fast-forward under its hints', () => {
    const ff =
      "hint: Diverging branches can't be fast-forwarded\nhint:\nhint: \tgit rebase\nfatal: Not possible to fast-forward, aborting.\n"
    expect(shortReason(ff)).toBe('Not possible to fast-forward, aborting.')
  })
  it('drops hint lines and the level word', () => {
    expect(shortReason('hint: x\nfatal: Not possible to fast-forward, aborting.')).toBe(
      'Not possible to fast-forward, aborting.'
    )
  })
  it('keeps a plain message as it is', () => {
    expect(shortReason('Not a git repository')).toBe('Not a git repository')
  })
})

describe('repoName', () => {
  it('is the last path segment, trailing slash or not', () => {
    expect(repoName('/a/b/crm')).toBe('crm')
    expect(repoName('/a/b/crm/')).toBe('crm')
  })
})
