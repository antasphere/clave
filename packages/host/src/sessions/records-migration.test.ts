import { describe, expect, it, vi } from 'vitest'
vi.mock('./adapters/pty-backend', () => ({ sessionRecordsDir: () => '/tmp/unused-records' }))
vi.mock('../workspace-manager', () => ({ workspaceManager: {} }))
import { migrateSessionAdapterRecord } from '../session-records-index'

describe('session adapter record migration', () => {
  it('loads a legacy record as the PTY adapter without dropping restore fields', () => {
    const legacy = {
      id: 'legacy',
      cwd: '/project',
      claudeSessionId: 'conversation',
      tmuxName: 'clave-session'
    }
    expect(migrateSessionAdapterRecord(legacy as typeof legacy & { adapterId?: string })).toEqual({
      ...legacy,
      adapterId: 'pty',
      transport: 'pty'
    })
  })
  it('preserves an explicit events adapter and is idempotent', () => {
    const record = { id: 'echo', adapterId: 'echo', transport: 'events' as const }
    expect(migrateSessionAdapterRecord(migrateSessionAdapterRecord(record))).toEqual(record)
  })
})
