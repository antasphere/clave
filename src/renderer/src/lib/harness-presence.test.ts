import { describe, expect, it } from 'vitest'
import { harnessPresent } from './harness-presence'
import type { AgentUpdateStatus } from '../../../shared/agent-updates'
import type { LaunchProfile } from '../../../shared/agent-launch'

const status = (installed: boolean, checked: boolean): AgentUpdateStatus =>
  ({ id: 'codex', installed, lastCheckedAt: checked ? 1 : null }) as AgentUpdateStatus
const profile = (id: string, builtIn = false): LaunchProfile => ({
  id,
  name: id,
  family: 'codex',
  command: ['codex'],
  additionalArgs: [],
  ...(builtIn ? { builtIn: true } : {})
})

describe('harnessPresent', () => {
  it('is present until a check said otherwise, and when the check found it', () => {
    expect(harnessPresent(undefined, [])).toBe(true)
    expect(harnessPresent(status(false, false), [])).toBe(true)
    expect(harnessPresent(status(true, true), [])).toBe(true)
  })
  it('is absent when a check found nothing and the person saved no profile of their own; a wrapper profile keeps it present', () => {
    expect(harnessPresent(status(false, true), [profile('builtin-codex', true)])).toBe(false)
    expect(harnessPresent(status(false, true), [profile('codex-chat', true)])).toBe(false)
    expect(harnessPresent(status(false, true), [profile('chat:codex:work')])).toBe(false)
    expect(harnessPresent(status(false, true), [profile('work')])).toBe(true)
  })
})
