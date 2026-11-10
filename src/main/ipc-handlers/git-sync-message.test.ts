import { describe, expect, it, vi } from 'vitest'

// Sync all's commit message (PRDCT-4330): written by the server when one of
// its own backs the window, by main's helper only in-process; a silent
// server is said in plain words, the server's own refusal passes through.
const state = vi.hoisted(() => ({ external: false }))
vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../server/endpoint', () => ({ isServerExternal: () => state.external }))
vi.mock('../git-manager', () => ({ gitManager: { setCommitMessageWriter: vi.fn() } }))
vi.mock('../git-watch', () => ({ GitRepoWatcher: class {} }))
vi.mock('../repo-index', () => ({ repoIndexManager: {} }))
vi.mock('../pull-log', () => ({ logPullFailures: vi.fn() }))

import { SERVER_SILENT, syncCommitMessage } from './git-handlers'

const serverWith = (generate: (cwd: string) => Promise<string>) => async () => ({
  git: { generateCommitMessage: generate }
})

describe("Sync all's commit message", () => {
  it('in-process: main’s own helper writes it, the server is not asked', async () => {
    state.external = false
    const local = vi.fn(async () => 'feat: local')
    const server = vi.fn()
    await expect(syncCommitMessage('/repo', local, server)).resolves.toBe('feat: local')
    expect(server).not.toHaveBeenCalled()
  })

  it('with a server of its own: the server writes it, main’s helper is not asked', async () => {
    state.external = true
    const local = vi.fn(async () => 'feat: local')
    const generate = vi.fn(async () => 'feat: from the server')
    await expect(syncCommitMessage('/repo', local, serverWith(generate))).resolves.toBe(
      'feat: from the server'
    )
    expect(generate).toHaveBeenCalledWith('/repo')
    expect(local).not.toHaveBeenCalled()
  })

  it('a server that does not answer is said without its address; its refusal passes through', async () => {
    state.external = true
    const local = vi.fn(async () => 'feat: local')
    const unreachable = Object.assign(
      new Error("Clave's server at http://127.0.0.1:5 did not answer"),
      {
        _tag: 'ServerUnreachable'
      }
    )
    await expect(
      syncCommitMessage(
        '/repo',
        local,
        serverWith(async () => Promise.reject(unreachable))
      )
    ).rejects.toThrow(SERVER_SILENT)
    await expect(
      syncCommitMessage('/repo', local, async () => Promise.reject(new Error('no server named')))
    ).rejects.toThrow(SERVER_SILENT)
    await expect(
      syncCommitMessage(
        '/repo',
        local,
        serverWith(async () =>
          Promise.reject(new Error('Switched off in Settings › Helpers (Commit messages).'))
        )
      )
    ).rejects.toThrow('Switched off in Settings › Helpers (Commit messages).')
    expect(local).not.toHaveBeenCalled()
  })
})
