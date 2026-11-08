import { describe, expect, it, vi } from 'vitest'
import {
  describeConnectionChange,
  recordConnectionChange,
  recordCredentialFailure
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
  it('writes a credential the registry could not open, with its safe sentence', () => {
    const log = logger()
    recordCredentialFailure(
      log,
      'srv-1',
      'Mac Studio',
      'The saved server credential is unavailable. Enter its token again.'
    )
    expect(log.warn).toHaveBeenCalledWith(
      '[fleet] Mac Studio (srv-1): credentials unavailable, The saved server credential is unavailable. Enter its token again.'
    )
  })
})
