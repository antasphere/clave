import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@clave/contract/sessions'
import { resumeOptions } from './resume-options'

/**
 * Lane C of the harness wave (PRDCT-4496): the stored connection a Pi or
 * OpenCode tab runs on. `records-contract.test.ts` holds the record across
 * the wire; this holds it across a Resume: a tab that ran on a connection
 * comes back on it, by id and label, never on the person's own login.
 */
const record: SessionRecord = {
  id: '9e3a0b11-0000-4000-8000-0000000000c1',
  cwd: '/repo',
  folderName: 'repo',
  adapterId: 'pi',
  transport: 'pty',
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  piMode: true,
  claudeAgentsMode: false,
  dangerousMode: false,
  model: 'deepseek-chat',
  piProvider: 'deepseek',
  piSessionId: 'pi-77',
  windowKey: 'mac-a',
  startedAt: 123,
  live: false
}

describe('resumeOptions carries the stored connection (PRDCT-4496)', () => {
  it('resumes a Pi tab on the connection it ran on, id and label', () => {
    const options = resumeOptions({
      ...record,
      connectionId: 'conn-7',
      connectionLabel: 'Team DeepSeek'
    })
    expect(options.connectionId).toBe('conn-7')
    expect(options.connectionLabel).toBe('Team DeepSeek')
    expect(options.resumeSessionId).toBe('pi-77')
  })

  it('resumes an OpenCode tab on its connection too', () => {
    const options = resumeOptions({
      ...record,
      piMode: false,
      opencodeMode: true,
      adapterId: 'opencode',
      connectionId: 'conn-8',
      connectionLabel: 'Team Kimi'
    })
    expect(options).toMatchObject({ connectionId: 'conn-8', connectionLabel: 'Team Kimi' })
  })

  it('names no connection for a tab that ran on none', () => {
    const options = resumeOptions(record)
    expect(options.connectionId).toBeUndefined()
    expect(options.connectionLabel).toBeUndefined()
  })
})
