import { describe, it, expect } from 'vitest'
import { logPullFailures } from './pull-log'

describe('logPullFailures', () => {
  it('writes one line per failed repo, with its path and its error, and nothing else', () => {
    const lines: string[] = []
    logPullFailures(
      [
        { repoPath: '/w/a', error: null },
        { repoPath: '/w/crm', error: 'CONFLICT (content): Merge conflict in f' }
      ],
      (l) => lines.push(l)
    )
    expect(lines).toEqual([
      '[git] Pull all could not pull /w/crm: CONFLICT (content): Merge conflict in f'
    ])
  })
})
