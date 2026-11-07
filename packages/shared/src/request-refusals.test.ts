import { describe, expect, it } from 'vitest'
import { requestGone } from './request-refusals'

describe('a refusal that says the request is gone', () => {
  it('recognises the request store and the adapters in their own words', () => {
    expect(requestGone(new Error('No such provider request.'))).toBe(true)
    expect(requestGone(new Error('The request was already settled.'))).toBe(true)
    expect(requestGone(new Error('Unknown Claude permission request: req-7'))).toBe(true)
    expect(requestGone(new Error('Unknown or expired Codex approval option'))).toBe(true)
  })
  it('recognises the same words wrapped by the IPC road, and a bare string', () => {
    expect(
      requestGone(
        new Error(
          "Error invoking remote method 'sessions:write': RequestRejected: No such provider request."
        )
      )
    ).toBe(true)
    expect(requestGone('The request was already settled.')).toBe(true)
  })
  it('leaves every other failure alone: an invalid option, a missing answer, a server down', () => {
    expect(requestGone(new Error('Invalid Claude permission option'))).toBe(false)
    expect(requestGone(new Error('An answer is required for each Codex question'))).toBe(false)
    expect(requestGone(new Error('Unknown Codex approval option'))).toBe(false)
    expect(requestGone(new Error('The server is stopping.'))).toBe(false)
    expect(requestGone(new Error("Clave's server at http://127.0.0.1:1 is unreachable"))).toBe(
      false
    )
    expect(requestGone(undefined)).toBe(false)
    expect(requestGone({ message: 'No such provider request.' })).toBe(false)
  })
})
