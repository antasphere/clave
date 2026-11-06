import { describe, it, expect } from 'vitest'
import { routineBadge } from './routine-badge'

const valid = { invalid: null }
type State = 'running' | 'waiting' | 'ok' | 'attention' | 'failed'
const run = (state: State, seen = false): { state: State; seen: boolean } => ({ state, seen })

describe('routineBadge', () => {
  it('a routine that never ran shows the bare icon', () => {
    expect(routineBadge({ routine: valid, runs: [] })).toEqual({
      state: 'never',
      working: false,
      dot: null
    })
  })
  it('a declaration that cannot run is a red dot, whatever its runs', () => {
    expect(routineBadge({ routine: { invalid: 'bad cron' }, runs: [run('ok')] })).toEqual({
      state: 'invalid',
      working: false,
      dot: 'invalid'
    })
  })
  it('a run in flight turns the ring and draws no dot', () => {
    expect(routineBadge({ routine: valid, runs: [run('running')] })).toEqual({
      state: 'running',
      working: true,
      dot: null
    })
  })
  it('a run in flight after an unseen result still shows the ring alone', () => {
    expect(routineBadge({ routine: valid, runs: [run('running'), run('failed')] })).toMatchObject({
      state: 'running',
      working: true,
      dot: null
    })
  })
  it('a run waiting on the person is a still amber dot, no motion', () => {
    expect(routineBadge({ routine: valid, runs: [run('waiting')] })).toEqual({
      state: 'waiting',
      working: false,
      dot: 'waiting'
    })
  })
  it.each([
    ['ok', 'ok'],
    ['attention', 'attention'],
    ['failed', 'failed']
  ] as const)('an unseen %s run is a dot in its tone', (state, tone) => {
    expect(routineBadge({ routine: valid, runs: [run(state)] })).toEqual({
      state,
      working: false,
      dot: tone
    })
  })
  it('a dismissed run leaves the bare icon and reads seen', () => {
    expect(routineBadge({ routine: valid, runs: [run('failed', true)] })).toEqual({
      state: 'seen',
      working: false,
      dot: null
    })
  })
})
