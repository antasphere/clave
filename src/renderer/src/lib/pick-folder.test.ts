import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'

const f = vi.hoisted(() => ({
  pickServerFolder: vi.fn(async () => '/srv/work/repo' as string | null),
  openFolderDialog: vi.fn(async () => '/Users/me/repo' as string | null)
}))
vi.mock('../store/fleet-store', () => ({
  useFleetStore: { getState: () => ({ connections: [{ id: 'studio', name: 'Studio' }] }) }
}))
vi.mock('../store/server-folder-store', () => ({ pickServerFolder: f.pickServerFolder }))
vi.stubGlobal('window', { electronAPI: { openFolderDialog: f.openFolderDialog } })

const { pickFolderOn } = await import('./pick-folder')

afterEach(() => vi.clearAllMocks())

describe('a folder is picked on the machine that will use it', () => {
  it('a server’s folder is picked in the server picker, never in this Mac’s dialog', async () => {
    expect(await pickFolderOn('studio', '/srv/work')).toBe('/srv/work/repo')
    expect(f.pickServerFolder).toHaveBeenCalledWith({
      serverId: 'studio',
      serverName: 'Studio',
      startPath: '/srv/work'
    })
    expect(f.openFolderDialog).not.toHaveBeenCalled()
  })

  it('a server not listed any more still gets the server picker, under a plain name', async () => {
    await pickFolderOn('gone')
    expect(f.pickServerFolder).toHaveBeenCalledWith({
      serverId: 'gone',
      serverName: 'Clave server',
      startPath: undefined
    })
    expect(f.openFolderDialog).not.toHaveBeenCalled()
  })

  it('this Mac’s folder is picked in this Mac’s dialog', async () => {
    expect(await pickFolderOn(LOCAL_SERVER_ID, '/Users/me')).toBe('/Users/me/repo')
    expect(f.openFolderDialog).toHaveBeenCalledWith('/Users/me')
    expect(f.pickServerFolder).not.toHaveBeenCalled()
  })

  it('a cancelled pick answers null on both roads', async () => {
    f.pickServerFolder.mockResolvedValueOnce(null)
    f.openFolderDialog.mockResolvedValueOnce(null)
    expect(await pickFolderOn('studio')).toBeNull()
    expect(await pickFolderOn(LOCAL_SERVER_ID)).toBeNull()
  })
})
