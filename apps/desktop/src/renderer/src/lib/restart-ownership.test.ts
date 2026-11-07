import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_COMPLETED_RESTARTS,
  abandonOwnRestart,
  beginOwnRestart,
  ownAnswerApplies,
  resetOwnRestarts,
  servedRestartApplies
} from './restart-ownership'
describe('restart operation ownership', () => {
  beforeEach(resetOwnRestarts)
  it('keeps pending ownership across arbitrary response delays', () => {
    beginOwnRestart('s', 'op')
    expect(servedRestartApplies('s', 'op')).toBe(true)
    expect(ownAnswerApplies('s', 'op', 'op')).toBe(false)
  })
  it('answer first suppresses only the exact operation push', () => {
    beginOwnRestart('s', 'op')
    expect(ownAnswerApplies('s', 'op', 'op')).toBe(true)
    expect(servedRestartApplies('s', 'other')).toBe(true)
    expect(servedRestartApplies('s')).toBe(true)
    expect(servedRestartApplies('other-session', 'op')).toBe(true)
    expect(servedRestartApplies('s', 'op')).toBe(false)
  })
  it('IPC and legacy answers release their marks without suppressing pushes', () => {
    beginOwnRestart('s', 'ipc')
    expect(ownAnswerApplies('s', 'ipc')).toBe(true)
    expect(servedRestartApplies('s', 'external')).toBe(true)
    expect(servedRestartApplies('s')).toBe(true)
  })
  it('failed calls abandon their marks so a late push applies', () => {
    beginOwnRestart('s', 'failed')
    abandonOwnRestart('failed')
    expect(servedRestartApplies('s', 'failed')).toBe(true)
  })
  it('bounds completed lost-push receipts without evicting pending calls', () => {
    beginOwnRestart('pending', 'pending-op')
    for (let i = 0; i <= MAX_COMPLETED_RESTARTS; i++) {
      const id = `completed-${i}`
      beginOwnRestart('s', id)
      expect(ownAnswerApplies('s', id, id)).toBe(true)
    }
    expect(servedRestartApplies('s', 'completed-0')).toBe(true)
    expect(servedRestartApplies('s', `completed-${MAX_COMPLETED_RESTARTS}`)).toBe(false)
    expect(ownAnswerApplies('pending', 'pending-op', 'pending-op')).toBe(true)
    expect(servedRestartApplies('pending', 'pending-op')).toBe(false)
  })
})
