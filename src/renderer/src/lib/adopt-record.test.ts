import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../../../preload/index.d'

const adoptSessionInPlace = vi.hoisted(() => vi.fn())
vi.mock('../store/session-store', () => ({
  useSessionStore: { getState: () => ({ adoptSessionInPlace }) }
}))
import { adoptRecord } from './adopt-record'

const spawnSession = vi.fn()
const startSession = vi.fn()
const resizeSession = vi.fn()
const record = {
  id: 'legacy-1',
  cwd: '/project',
  folderName: 'project',
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  dangerousMode: false,
  live: false
} as SessionRecord

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { electronAPI: { spawnSession, startSession, resizeSession } })
  spawnSession.mockImplementation(async () => ({ ...record, alive: true }))
})

describe('legacy record adoption', () => {
  it.each(['claudeMode', 'codexMode', 'piMode'])(
    'adopts %s metadata without starting a PTY',
    async (mode) => {
      for (const live of [false, true]) {
        expect(await adoptRecord({ ...record, [mode]: true, live }, 'workspace')).toBe(record.id)
        expect(adoptSessionInPlace).toHaveBeenLastCalledWith(
          expect.objectContaining({
            id: record.id,
            legacyAgentId: record.id,
            alive: live,
            workspaceId: 'workspace'
          }),
          { focus: false }
        )
      }
      expect(spawnSession).not.toHaveBeenCalled()
      expect(startSession).not.toHaveBeenCalled()
      expect(resizeSession).not.toHaveBeenCalled()
    }
  )

  it.each([
    {},
    { claudeMode: true, antigravityMode: true },
    { claudeMode: true, claudeAgentsMode: true },
    { claudeMode: true, link: { kind: 'session-view', ownerId: 'owner' } }
  ])('keeps ordinary/unsupported/hidden records on the existing spawn path', async (modes) => {
    await adoptRecord({ ...record, ...modes } as SessionRecord, null)
    expect(spawnSession).toHaveBeenCalledOnce()
    expect(adoptSessionInPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyAgentId: undefined
      }),
      { focus: false }
    )
  })
})
