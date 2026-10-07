import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileStorage } from './ports/storage'
import { installTerminalPorts, resetTerminalPorts } from './ports/terminals'
import { tempDataDir } from './ports/testing'
import {
  clearState,
  getStateDir,
  startWatching,
  stateFilePath,
  stopWatching
} from './agent-state-manager'
import { sessionManager } from './sessions/session-manager'

/**
 * The agent state folder through the storage port: the hooks a Claude
 * session is launched with write one word into `<data>/agent-state/<id>.state`,
 * and the watch turns it into a state transition. Nothing here asks Electron
 * where the folder is.
 */
let dir: string

beforeEach(() => {
  dir = tempDataDir()
  installTerminalPorts({ storage: fileStorage(dir) })
})
afterEach(() => {
  stopWatching()
  resetTerminalPorts()
})

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

describe('the agent state folder', () => {
  it('lives under the storage port’s data directory and is created on first ask', () => {
    expect(getStateDir()).toBe(path.join(dir, 'agent-state'))
    expect(fs.existsSync(path.join(dir, 'agent-state'))).toBe(true)
    expect(stateFilePath('abc')).toBe(path.join(dir, 'agent-state', 'abc.state'))
  })

  it('forwards a valid word written by a hook, ignores the rest, and clears on request', async () => {
    const states: [string, string][] = []
    const setState = vi.spyOn(sessionManager, 'setState').mockImplementation(() => {})
    startWatching((id, state) => states.push([id, state]))
    // The watch is installed at boot in the app, long before a hook writes;
    // here the kernel gets a moment to arm it before the first write.
    await new Promise((r) => setTimeout(r, 300))
    // The kernel may deliver one write as two events, or two writes as one
    // (the runner's watcher does), so the assertions are on the words that
    // arrive and the last one, never on how many events it took.
    fs.writeFileSync(stateFilePath('s1'), 'working')
    expect(await until(() => states.length >= 1)).toBe(true)
    expect(states[0]).toEqual(['s1', 'working'])
    expect(setState).toHaveBeenCalledWith('s1', 'working')
    fs.writeFileSync(stateFilePath('s1'), 'not-a-state')
    fs.writeFileSync(path.join(getStateDir(), 'notes.txt'), 'idle')
    fs.writeFileSync(stateFilePath('s1'), 'done')
    expect(await until(() => states.at(-1)?.[1] === 'done')).toBe(true)
    expect(
      states.every(([id, word]) => id === 's1' && (word === 'working' || word === 'done'))
    ).toBe(true)
    expect(setState).not.toHaveBeenCalledWith('s1', 'not-a-state')
    clearState('s1')
    expect(fs.existsSync(stateFilePath('s1'))).toBe(false)
    clearState('s1')
    setState.mockRestore()
  })
})
