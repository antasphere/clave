import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * An artefact link across a restart of the server inside the app, over the
 * REAL terminal backend and the REAL service on one data folder. A terminal
 * tab that runs in tmux keeps its record under its tmux name, and the backend
 * finds that record by the tab's id only once a window has taken the tab back,
 * long after the service starts. The service once dropped every link whose
 * session it did not know at start, so such a tab lost its link at every
 * restart; this test holds the rule that replaced it.
 *
 * Every tmux call is intercepted, as in `pty-backend-tmux.test.ts`: what is
 * under test is where the record lives and what the service does with it.
 */
vi.mock('child_process', async (original) => {
  const real = await original<typeof import('child_process')>()
  return {
    ...real,
    execFile: vi.fn((_file: string, _args: string[], ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === 'function') as ((err: null) => void) | undefined
      cb?.(null)
      return { on: () => {} }
    }),
    // No login shell: the backend falls back to this process's environment,
    // where tmux is found on the PATH or the suite skips.
    execFileSync: vi.fn(() => '')
  }
})

import { ForwardRegistry } from '@clave/server/forward-registry'
import { installSettingsPorts, resetSettingsPorts } from '../ports/registry'
import { installTerminalPorts, resetTerminalPorts } from '../ports/terminals'
import { fileStorage } from '../ports/storage'
import type { TerminalPort } from '../ports/terminal'
import { electronTestPorts, tempDataDir } from '../ports/testing'
import { PtyBackend, isTmuxAvailable } from '../sessions/adapters/pty-backend'
import { ArtefactLinks, fileLinksStorage } from './links'
import { createArtefactService, type ArtefactServiceHandle } from './service'

const terminals: TerminalPort = {
  spawn: () => ({
    pid: 1,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => () => {},
    onExit: () => () => {}
  })
}

const services: ArtefactServiceHandle[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  resetTerminalPorts()
  resetSettingsPorts()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!isTmuxAvailable())('an artefact link across a restart', () => {
  it('keeps the link of a tmux terminal tab that the restarted server does not know yet', async () => {
    const dir = tempDataDir()
    dirs.push(dir)
    installSettingsPorts(electronTestPorts(dir))
    installTerminalPorts({ storage: fileStorage(dir), terminals })
    const cwd = fs.realpathSync(tempDataDir('clave-artefact-restart-cwd-'))
    dirs.push(cwd)
    const deck = path.join(cwd, 'deck')
    fs.mkdirSync(deck)
    fs.writeFileSync(path.join(deck, 'index.html'), '<h1>deck</h1>')
    const linksFile = path.join(dir, 'artefacts.json')
    const serviceOver = (backend: PtyBackend): ArtefactServiceHandle => {
      const service = createArtefactService({
        dataDir: dir,
        execPath: process.execPath,
        // No command line: nothing here starts a preview.
        env: { CLAVE_SLIDELESS_CLI: path.join(dir, 'no-such-cli') },
        links: new ArtefactLinks(fileLinksStorage(linksFile), () => {}),
        forwards: new ForwardRegistry(),
        sessions: {
          knows: (id) => Boolean(backend.getSessionRecord(id)),
          onState: () => () => {}
        },
        autoInstall: false,
        log: () => {}
      })
      services.push(service)
      return service
    }
    const linked = (): string[] =>
      Object.keys(
        (JSON.parse(fs.readFileSync(linksFile, 'utf8')) as { artefacts: Record<string, unknown> })
          .artefacts
      )

    // Process one: the tab, its artefact, then a quit, which detaches the tab
    // and keeps its tmux session and its record.
    const one = new PtyBackend()
    const tab = one.spawn(cwd, { claudeMode: false, tmuxMode: true })
    one.start(tab.id, 80, 24)
    const before = serviceOver(one)
    await before.open(tab.id, deck)
    expect(linked()).toEqual([tab.id])
    await before.stop()
    one.kill(tab.id, false)

    // Process two: a fresh backend and a fresh service over the same folder,
    // before any window has taken the tab back.
    const two = new PtyBackend()
    expect(two.listAdoptableSessions().map((r) => r.id)).toContain(tab.id)
    // The fact that made the defect: the record is not found by the tab's id yet.
    expect(two.getSessionRecord(tab.id)).toBeNull()
    const after = serviceOver(two)
    after.start()
    expect(linked()).toEqual([tab.id])
    expect((await after.list()).map((a) => [a.sessionId, a.target])).toEqual([[tab.id, deck]])
    expect(linked()).toEqual([tab.id])
  })
})
