import { describe, expect, it } from 'vitest'
import { agentUpdateSchedule } from './schedule'

const base = { testMode: false, packaged: true, platform: 'darwin' as const, env: {} }
const seams = {
  CLAVE_TEST_AGENT_PATH: '/fixture/bin',
  CLAVE_TEST_NPM_REGISTRY: 'http://127.0.0.1:1'
}

describe('when the agent updater runs on its own', () => {
  it('runs in the shipped app', () => {
    expect(agentUpdateSchedule(base).scheduled).toBe(true)
  })

  it('never runs in test mode, even packaged or asked to', () => {
    expect(
      agentUpdateSchedule({ ...base, testMode: true, env: { CLAVE_AGENT_UPDATES_AUTO: '1' } })
        .scheduled
    ).toBe(false)
  })

  it('stays off in a dev build unless asked', () => {
    expect(agentUpdateSchedule({ ...base, packaged: false }).scheduled).toBe(false)
    expect(
      agentUpdateSchedule({ ...base, packaged: false, env: { CLAVE_AGENT_UPDATES_AUTO: '1' } })
        .scheduled
    ).toBe(true)
  })

  it('is unsupported and never scheduled on Windows', () => {
    const win = agentUpdateSchedule({ ...base, platform: 'win32' })
    expect(win.supported).toBe(false)
    expect(win.scheduled).toBe(false)
  })
})

describe('the test seams', () => {
  it('are honoured in test mode', () => {
    const s = agentUpdateSchedule({ ...base, testMode: true, env: seams })
    expect(s.agentPath).toBe('/fixture/bin')
    expect(s.registry).toBe('http://127.0.0.1:1')
  })

  it('are unreachable outside test mode, whatever the environment says', () => {
    const s = agentUpdateSchedule({ ...base, env: seams })
    expect(s.agentPath).toBeUndefined()
    expect(s.registry).toBeUndefined()
  })
})
