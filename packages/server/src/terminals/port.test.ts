import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { Terminals } from './port'

describe('the terminals port', () => {
  it('is provided as a layer and read back as the service given', async () => {
    const spawn = (): never => {
      throw new Error('not in this test')
    }
    const service = await Effect.runPromise(Effect.provide(Terminals, Terminals.layer({ spawn })))
    expect(service.spawn).toBe(spawn)
  })

  it('none says what is missing, as the declared capability error', () => {
    expect(() =>
      Terminals.none.spawn({ file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })
    ).toThrow(CapabilityUnavailable)
    try {
      Terminals.none.spawn({ file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })
    } catch (err) {
      expect((err as CapabilityUnavailable).capability).toBe('terminals')
      expect((err as CapabilityUnavailable).message).toMatch(/no terminals/)
    }
  })
})
