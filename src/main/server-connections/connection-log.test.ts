import { describe, expect, it, vi } from 'vitest'
import {
  CREDENTIAL_UNAVAILABLE,
  describeConnectionChange,
  isCredentialUnavailable,
  recordConnectionChange,
  recordCredentialFailure,
  recordCredentialOpened
} from './connection-log'

const logger = (): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } => ({
  info: vi.fn(),
  warn: vi.fn()
})

describe('the server connection log (PRDCT-4165)', () => {
  it('writes a failed connection with its reason, as a warning', () => {
    const log = logger()
    recordConnectionChange(
      log,
      { serverId: 'srv-1', state: 'offline', error: 'unreachable' },
      'Mac Studio',
      2
    )
    expect(log.warn).toHaveBeenCalledWith(
      '[fleet] Mac Studio (srv-1) (window 2): offline, unreachable: the server did not answer at its address'
    )
    expect(log.info).not.toHaveBeenCalled()
  })
  it('names a refused token and an unreadable credential', () => {
    expect(
      describeConnectionChange(
        { serverId: 'srv-1', state: 'unauthorized', error: 'unauthorized' },
        'Mac Studio',
        null
      )
    ).toEqual({
      line: '[fleet] Mac Studio (srv-1): unauthorized, the server refused the token',
      level: 'warn'
    })
    expect(
      describeConnectionChange(
        { serverId: 'srv-1', state: 'offline', error: 'credentials-unavailable' },
        'Mac Studio',
        null
      )?.line
    ).toContain('credentials unavailable: the saved token could not be read on this Mac')
  })
  it('writes a connection made, and a disconnect, as information', () => {
    const log = logger()
    recordConnectionChange(log, { serverId: 'srv-1', state: 'connected' }, 'Mac Studio', 1)
    recordConnectionChange(log, { serverId: 'srv-1', state: 'disconnected' }, 'Mac Studio', 1)
    expect(log.info.mock.calls.map((c) => c[0])).toEqual([
      '[fleet] Mac Studio (srv-1) (window 1): connected',
      '[fleet] Mac Studio (srv-1) (window 1): disconnected'
    ])
    expect(log.warn).not.toHaveBeenCalled()
  })
  it('refuses a payload outside the closed vocabulary and echoes nothing from it', () => {
    const log = logger()
    recordConnectionChange(log, { serverId: 'srv-1', state: 'token=abc' }, 'Mac Studio', 1)
    recordConnectionChange(log, 'offline', 'Mac Studio', 1)
    recordConnectionChange(log, { state: 'offline' }, 'Mac Studio', 1)
    expect(log.info).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    const line = describeConnectionChange(
      { serverId: 'srv-1', state: 'offline', error: 'Bearer secret' },
      'Mac Studio',
      1
    )?.line
    expect(line).toBe('[fleet] Mac Studio (srv-1) (window 1): offline')
  })
  it('writes a credential the registry could not open once, with its safe sentence, until it opens again', () => {
    const log = logger()
    expect(recordCredentialFailure(log, 'srv-9', 'Mac Studio', CREDENTIAL_UNAVAILABLE)).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(
      '[fleet] Mac Studio (srv-9): credentials unavailable, The saved server credential is unavailable. Enter its token again.'
    )
    // Every window retries every few seconds: the second failure in a row is not written.
    expect(recordCredentialFailure(log, 'srv-9', 'Mac Studio', CREDENTIAL_UNAVAILABLE)).toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
    recordCredentialOpened('srv-9')
    expect(recordCredentialFailure(log, 'srv-9', 'Mac Studio', CREDENTIAL_UNAVAILABLE)).toBe(true)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
  it('knows the registry’s credential sentence from its other refusals', () => {
    expect(isCredentialUnavailable(new Error(CREDENTIAL_UNAVAILABLE))).toBe(true)
    expect(isCredentialUnavailable(new Error('This server connection is disconnected.'))).toBe(
      false
    )
    expect(isCredentialUnavailable(new Error('Unknown server connection.'))).toBe(false)
    expect(isCredentialUnavailable(CREDENTIAL_UNAVAILABLE)).toBe(false)
  })
})
