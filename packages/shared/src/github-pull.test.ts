import { describe, expect, it } from 'vitest'
import {
  ghArgs,
  ghSpawnEnv,
  parsePullRequestUrl,
  pullRequestFromGh,
  splitUnifiedDiff,
  summarizeChecks,
  GH_PULL_FIELDS,
  type GhPullRaw,
  type PullCheck
} from './github-pull'

describe('parsePullRequestUrl', () => {
  const ref = { owner: 'antasphere', repo: 'clave', number: 86 }
  it('recognises the canonical link and its tabs, queries and fragments', () => {
    for (const href of [
      'https://github.com/antasphere/clave/pull/86',
      'https://github.com/antasphere/clave/pull/86/',
      'https://github.com/antasphere/clave/pull/86/files',
      'https://github.com/antasphere/clave/pull/86/commits',
      'https://github.com/antasphere/clave/pull/86/checks',
      'https://github.com/antasphere/clave/pull/86#discussion_r12345',
      'https://github.com/antasphere/clave/pull/86?diff=split',
      'https://www.github.com/antasphere/clave/pull/86',
      'http://github.com/antasphere/clave/pull/86'
    ])
      expect(parsePullRequestUrl(href), href).toEqual(ref)
  })
  it('refuses everything that is not a pull request on github.com', () => {
    for (const href of [
      'https://github.com/antasphere/clave/issues/86',
      'https://github.com/antasphere/clave',
      'https://github.com/antasphere/clave/pull/',
      'https://github.com/antasphere/clave/pull/abc',
      'https://github.com/antasphere/clave/pull/86/reviews',
      'https://api.github.com/repos/antasphere/clave/pulls/86',
      'https://ghe.example.com/antasphere/clave/pull/86',
      'https://github.com.evil.example/antasphere/clave/pull/86',
      'https://github.com/-owner/clave/pull/86',
      'https://github.com/antasphere/clave%2F..%2Fx/pull/86',
      'file:///github.com/antasphere/clave/pull/86',
      'not a url',
      ''
    ])
      expect(parsePullRequestUrl(href), href).toBeNull()
  })
})

describe('ghArgs', () => {
  const ref = { owner: 'acme', repo: 'widgets', number: 42 }
  it('names the pull request positionally and the repository by flag', () => {
    expect(ghArgs.view(ref)).toEqual([
      'pr',
      'view',
      '42',
      '--repo',
      'acme/widgets',
      '--json',
      GH_PULL_FIELDS.join(',')
    ])
    expect(ghArgs.diff(ref)).toEqual(['pr', 'diff', '42', '--repo', 'acme/widgets'])
    expect(ghArgs.merge(ref, 'squash')).toEqual([
      'pr',
      'merge',
      '42',
      '--repo',
      'acme/widgets',
      '--squash'
    ])
  })
  it('sends every body on stdin so a comment can never become a flag', () => {
    expect(ghArgs.comment(ref).slice(-2)).toEqual(['--body-file', '-'])
    expect(ghArgs.review(ref, 'approve')).toContain('--approve')
    expect(ghArgs.review(ref, 'request_changes')).toContain('--request-changes')
    expect(ghArgs.review(ref, 'comment')).toContain('--comment')
    for (const event of ['approve', 'request_changes', 'comment'] as const)
      expect(ghArgs.review(ref, event).slice(-2)).toEqual(['--body-file', '-'])
  })
})

describe('pullRequestFromGh', () => {
  const ref = { owner: 'acme', repo: 'widgets', number: 42 }
  const raw: GhPullRaw = {
    number: 42,
    title: 'Add the widget',
    body: 'Body **markdown**',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/acme/widgets/pull/42',
    author: { login: 'octocat', is_bot: false },
    createdAt: '2026-09-20T10:00:00Z',
    updatedAt: '2026-09-21T10:00:00Z',
    mergedAt: null,
    baseRefName: 'dev',
    headRefName: 'feat/widget',
    headRepositoryOwner: { login: 'forker' },
    isCrossRepository: true,
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    commits: [{}, {}, {}],
    labels: [{ name: 'feature', color: '0e8a16' }, { name: '' }],
    reviewRequests: [{ login: 'reviewer' }, { slug: 'core-team' }],
    reviewDecision: 'CHANGES_REQUESTED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'build',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/acme/widgets/actions/runs/1'
      },
      { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
      {
        __typename: 'StatusContext',
        context: 'coverage',
        state: 'FAILURE',
        targetUrl: 'https://cov'
      }
    ],
    files: [
      { path: 'src/a.ts', additions: 8, deletions: 0, changeType: 'ADDED' },
      { path: 'src/b.ts', additions: 2, deletions: 2, changeType: 'MODIFIED' }
    ],
    comments: [
      {
        id: 'c2',
        author: { login: 'bob' },
        body: 'later comment',
        createdAt: '2026-09-21T09:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-2'
      },
      { id: 'c1', author: { login: 'alice' }, body: 'first', createdAt: '2026-09-20T11:00:00Z' }
    ],
    reviews: [
      {
        id: 'r1',
        author: { login: 'reviewer' },
        body: 'please fix',
        submittedAt: '2026-09-20T12:00:00Z',
        state: 'CHANGES_REQUESTED'
      },
      { id: 'r0', author: { login: 'reviewer' }, body: '', submittedAt: '', state: 'PENDING' }
    ]
  }
  it('maps the record and orders the conversation by time', () => {
    const view = pullRequestFromGh(ref, raw)
    expect(view).toMatchObject({
      ref,
      number: 42,
      title: 'Add the widget',
      state: 'open',
      author: 'octocat',
      base: 'dev',
      head: 'feat/widget',
      headOwner: 'forker',
      additions: 10,
      deletions: 2,
      changedFiles: 2,
      commits: 3,
      labels: [{ name: 'feature', color: '0e8a16' }],
      reviewers: ['reviewer', 'core-team'],
      reviewDecision: 'changes_requested',
      mergeable: 'mergeable',
      mergeState: 'blocked'
    })
    expect(view.checks.map((check) => [check.name, check.status])).toEqual([
      ['build', 'success'],
      ['lint', 'pending'],
      ['skip', 'skipped'],
      ['coverage', 'failure']
    ])
    expect(view.checks[3].url).toBe('https://cov')
    expect(view.files.map((file) => [file.path, file.change])).toEqual([
      ['src/a.ts', 'added'],
      ['src/b.ts', 'modified']
    ])
    expect(view.timeline.map((item) => item.id)).toEqual(['c1', 'r1', 'c2'])
    expect(view.timeline[1]).toMatchObject({ kind: 'review', state: 'changes_requested' })
  })
  it('reads draft, merged and closed off the record', () => {
    expect(pullRequestFromGh(ref, { ...raw, isDraft: true }).state).toBe('draft')
    expect(pullRequestFromGh(ref, { ...raw, state: 'MERGED', isDraft: true }).state).toBe('merged')
    expect(pullRequestFromGh(ref, { ...raw, state: 'CLOSED' }).state).toBe('closed')
  })
  it('keeps the head owner only for a cross-repository head', () => {
    expect(pullRequestFromGh(ref, { ...raw, isCrossRepository: false }).headOwner).toBeNull()
  })
  it('survives an empty record from an older gh', () => {
    const view = pullRequestFromGh(ref, {})
    expect(view).toMatchObject({
      number: 42,
      title: '#42',
      url: 'https://github.com/acme/widgets/pull/42',
      state: 'open',
      author: 'ghost',
      checks: [],
      files: [],
      timeline: [],
      mergeable: 'unknown',
      reviewDecision: null
    })
  })
})

describe('summarizeChecks', () => {
  const check = (
    status: 'success' | 'failure' | 'pending' | 'skipped' | 'cancelled'
  ): PullCheck => ({
    name: status,
    workflow: null,
    status,
    url: null
  })
  it('gives a failure precedence over a pending run, and pending over success', () => {
    expect(summarizeChecks([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      verdict: 'none'
    })
    expect(summarizeChecks([check('success'), check('skipped')]).verdict).toBe('success')
    expect(summarizeChecks([check('success'), check('pending')]).verdict).toBe('pending')
    expect(summarizeChecks([check('pending'), check('failure')]).verdict).toBe('failure')
    expect(summarizeChecks([check('cancelled')])).toMatchObject({ failed: 1, verdict: 'failure' })
  })
})

describe('splitUnifiedDiff', () => {
  const raw = [
    'diff --git a/src/a.ts b/src/a.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/old name.ts b/new name.ts',
    'similarity index 90%',
    'rename from old name.ts',
    'rename to new name.ts',
    '--- a/old name.ts',
    '+++ b/new name.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    ''
  ].join('\n')
  it('yields one patch per file, keyed by the new path', () => {
    const files = splitUnifiedDiff(raw)
    expect(files.map((file) => [file.path, file.oldPath, file.change])).toEqual([
      ['src/a.ts', null, 'added'],
      ['new name.ts', 'old name.ts', 'renamed'],
      ['gone.ts', 'gone.ts', 'deleted'],
      ['img.png', null, 'modified']
    ])
    expect(files[0].patch).toContain('@@ -0,0 +1,2 @@\n+one\n+two')
    expect(files[0].patch).not.toContain('rename')
    expect(files[3].patch).toContain('Binary files')
  })
  it('is empty for no diff', () => {
    expect(splitUnifiedDiff('')).toEqual([])
    expect(splitUnifiedDiff('\n')).toEqual([])
  })
})

describe('ghSpawnEnv', () => {
  it("runs gh on its stored login by dropping the login shell's token variables", () => {
    const plan = ghSpawnEnv({ PATH: '/bin', GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'gho_y', HOME: '/h' })
    expect(plan.env).toEqual({ PATH: '/bin', HOME: '/h' })
  })
  it('keeps the token for one retry, for the user whose only sign-in is the variable', () => {
    const plan = ghSpawnEnv({ PATH: '/bin', GITHUB_TOKEN: 'ghp_x' })
    expect(plan.withToken).toEqual({ PATH: '/bin', GITHUB_TOKEN: 'ghp_x' })
  })
  it('has nothing to retry with when the login shell carried no token', () => {
    const plan = ghSpawnEnv({ PATH: '/bin' })
    expect(plan.env).toEqual({ PATH: '/bin' })
    expect(plan.withToken).toBeUndefined()
  })
})
