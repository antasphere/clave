import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_RECORD, useGithubPanelStore } from './store'
import { pullRefKey, type PullRef, type PullRequestView } from '../../../../packages/shared/src/github-pull'

const a: PullRef = { owner: 'acme', repo: 'widgets', number: 42 }
const b: PullRef = { owner: 'acme', repo: 'widgets', number: 43 }
const view = { title: 'Forty-two', state: 'open' } as unknown as PullRequestView

describe('the pull request records (PRDCT-4142)', () => {
  beforeEach(() => useGithubPanelStore.setState({ current: null, recent: [], records: {} }))

  it('starts a pull request never seen from the empty record and keeps every other field', () => {
    useGithubPanelStore.getState().update(a, { draft: 'Looks go' })
    expect(useGithubPanelStore.getState().records[pullRefKey(a)]).toEqual({
      ...EMPTY_RECORD,
      draft: 'Looks go'
    })
    useGithubPanelStore.getState().update(a, { view })
    expect(useGithubPanelStore.getState().records[pullRefKey(a)]).toEqual({
      ...EMPTY_RECORD,
      draft: 'Looks go',
      view
    })
  })

  it('keeps one record per pull request', () => {
    useGithubPanelStore.getState().update(a, { draft: 'on 42' })
    useGithubPanelStore.getState().update(b, { draft: 'on 43' })
    expect(useGithubPanelStore.getState().records[pullRefKey(a)].draft).toBe('on 42')
    expect(useGithubPanelStore.getState().records[pullRefKey(b)].draft).toBe('on 43')
  })

  it('leaves the record alone when the pull request is opened again or closed', () => {
    useGithubPanelStore.getState().update(a, { view, draft: 'half a sentence' })
    useGithubPanelStore.getState().open(a)
    useGithubPanelStore.getState().close()
    useGithubPanelStore.getState().open(a)
    expect(useGithubPanelStore.getState().records[pullRefKey(a)]).toEqual({
      ...EMPTY_RECORD,
      view,
      draft: 'half a sentence'
    })
  })

  it('never hands out a shared empty record to write into', () => {
    useGithubPanelStore.getState().update(a, { draft: 'x' })
    expect(EMPTY_RECORD.draft).toBe('')
  })
})
