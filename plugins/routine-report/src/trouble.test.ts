import { describe, expect, it } from 'vitest'
import { failedRunTrouble, invalidTrouble, storeTrouble } from './trouble'

/** A routine never shows a raw error as the message: plain words first, the
 *  raw text kept for Details; a window still reaching its server is not
 *  trouble at all (the panel says it is connecting). */
describe('routine trouble', () => {
  it('reads "not reached yet" as connecting, not as an error', () => {
    expect(
      storeTrouble("The routines are the server's: this window has not reached it yet")
    ).toBeNull()
  })
  it('puts any other store error in words, the raw text under Details', () => {
    const t = storeTrouble('Error invoking remote method: boom')
    expect(t?.title).toBe('Clave could not reach the routines')
    expect(t?.detail).toBe('Error invoking remote method: boom')
    expect(t?.tone).toBe('attention')
  })
  it('names an invalid declaration and keeps its reason', () => {
    const t = invalidTrouble('schedule: not a cron expression')
    expect(t.tone).toBe('invalid')
    expect(t.detail).toBe('schedule: not a cron expression')
  })
  it('names a run cut short by a quit or a restart, calmly, not as a failure of the agent', () => {
    const t = failedRunTrouble(
      'interrupted before its report: Clave quit or restarted, or the run was stopped'
    )
    expect(t.title).toBe('The run was interrupted')
    expect(t.tone).toBe('attention')
    expect(failedRunTrouble('the server stopped during the run').title).toBe(
      'The run was interrupted'
    )
  })
  it("says a failed run in words, the agent's headline first when it gave one", () => {
    expect(failedRunTrouble('timeout after 30 min').text).toMatch(/stopped before/)
    expect(failedRunTrouble('x', 'Doctor could not reach Steward').text).toBe(
      'Doctor could not reach Steward'
    )
  })
})
