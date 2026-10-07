import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { installSettingsPorts, resetSettingsPorts } from '../../ports/registry'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import { fileStorage } from '../../ports/storage'
import type { TerminalPort, TerminalProcess, TerminalSpawn } from '../../ports/terminal'
import { electronTestPorts, tempDataDir } from '../../ports/testing'
import {
  PtyBackend,
  SESSION_RECORDS_FOLDER,
  sessionRecordsDir,
  type SessionRecord
} from './pty-backend'

/**
 * The terminal backend over its ports: a fake process behind the terminal
 * port, a temp directory behind the storage port, a recording MCP config
 * port. What is proven here is silent if wrong in the app: a record that
 * lands in the wrong folder is a tab that never comes back, a spawn whose
 * arguments lose the MCP config is an agent with no tools, a kill that keeps
 * the record is a ghost offered at every launch.
 */
interface FakeProcess extends TerminalProcess {
  spec: TerminalSpawn
  written: string[]
  sizes: [number, number][]
  killed: boolean
  emitData(data: string): void
  emitExit(code: number): void
}

function fakeTerminals(): TerminalPort & { processes: FakeProcess[] } {
  const processes: FakeProcess[] = []
  return {
    processes,
    spawn(spec) {
      const data = new Set<(d: string) => void>()
      const exit = new Set<(e: { exitCode: number }) => void>()
      const process: FakeProcess = {
        spec,
        pid: 1000 + processes.length,
        written: [],
        sizes: [],
        killed: false,
        write: (d) => process.written.push(d),
        resize: (c, r) => process.sizes.push([c, r]),
        kill: () => {
          process.killed = true
          process.emitExit(-1)
        },
        onData: (l) => {
          data.add(l)
          return () => data.delete(l)
        },
        onExit: (l) => {
          exit.add(l)
          return () => exit.delete(l)
        },
        emitData: (d) => data.forEach((l) => l(d)),
        emitExit: (code) => exit.forEach((l) => l({ exitCode: code }))
      }
      processes.push(process)
      return process
    }
  }
}

// The backend reads the login shell's environment once, through the user's
// shell: a plain sh answers in milliseconds, the person's own may take
// seconds (a Nushell profile does), and this suite is about the ports.
process.env.SHELL = '/bin/sh'

let dir: string
let terminals: ReturnType<typeof fakeTerminals>
let mcpConfig: { write: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
let backend: PtyBackend
const cwd = fs.realpathSync(tempDataDir('clave-pty-cwd-'))

const recordFile = (key: string): string => path.join(dir, SESSION_RECORDS_FOLDER, `${key}.json`)
const readRecord = (key: string): SessionRecord =>
  JSON.parse(fs.readFileSync(recordFile(key), 'utf-8')) as SessionRecord

beforeEach(() => {
  dir = tempDataDir()
  installSettingsPorts(electronTestPorts(dir))
  terminals = fakeTerminals()
  mcpConfig = {
    write: vi.fn((id: string) => path.join(dir, 'mcp-configs', `${id}.json`)),
    remove: vi.fn()
  }
  installTerminalPorts({ storage: fileStorage(dir), terminals, mcpConfig })
  backend = new PtyBackend()
})
afterEach(() => {
  resetTerminalPorts()
  resetSettingsPorts()
})

describe('a plain terminal', () => {
  it('is planned with a record under the data directory and started through the terminal port at the real size', () => {
    const session = backend.spawn(cwd, { claudeMode: false, tmuxMode: false })
    expect(session.alive).toBe(true)
    expect(session.ptyProcess).toBeNull()
    // The literal, not the constant: an existing install keeps its records
    // under this name and nothing migrates a renamed folder.
    expect(sessionRecordsDir()).toBe(path.join(dir, 'session-records'))
    expect(SESSION_RECORDS_FOLDER).toBe('session-records')
    const record = readRecord(session.id)
    expect(record).toMatchObject({
      id: session.id,
      cwd,
      claudeMode: false,
      adapterId: 'pty',
      transport: 'pty'
    })
    expect(record.tmuxName).toBeUndefined()
    expect(terminals.processes).toHaveLength(0)
    expect(mcpConfig.write).not.toHaveBeenCalled()

    const out: string[] = []
    const exits: number[] = []
    backend.attachListeners(
      session.id,
      (d) => out.push(d),
      (c) => exits.push(c)
    )
    backend.start(session.id, 132, 44)
    expect(terminals.processes).toHaveLength(1)
    const process = terminals.processes[0]
    expect(process.spec.cols).toBe(132)
    expect(process.spec.rows).toBe(44)
    expect(process.spec.cwd).toBe(cwd)
    expect(process.spec.name).toBe('xterm-256color')
    expect(process.spec.env.TERM).toBe('xterm-256color')
    expect(process.spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(session.ptyProcess).toBe(process)

    process.emitData('hello')
    expect(out).toEqual(['hello'])
    backend.write(session.id, 'ls\r')
    expect(process.written).toEqual(['ls\r'])
    backend.resize(session.id, 100, 30)
    expect(process.sizes).toEqual([[100, 30]])
    // A second start is a resize, never a second process.
    backend.start(session.id, 90, 20)
    expect(terminals.processes).toHaveLength(1)
    expect(process.sizes).toEqual([
      [100, 30],
      [90, 20]
    ])

    process.emitExit(7)
    expect(exits).toEqual([7])
    expect(session.alive).toBe(false)
  })

  it('a resize before the start is the start, at that size', () => {
    const session = backend.spawn(cwd, { claudeMode: false, tmuxMode: false })
    backend.resize(session.id, 80, 24)
    expect(terminals.processes).toHaveLength(1)
    expect(terminals.processes[0].spec.cols).toBe(80)
  })

  it('a real close kills the process and takes the record with it; a quit keeps the record', () => {
    const closed = backend.spawn(cwd, { claudeMode: false, tmuxMode: false })
    backend.start(closed.id, 80, 24)
    backend.kill(closed.id)
    expect(terminals.processes[0].killed).toBe(true)
    expect(fs.existsSync(recordFile(closed.id))).toBe(false)
    expect(backend.getSession(closed.id)).toBeUndefined()

    const kept = backend.spawn(cwd, { claudeMode: false, tmuxMode: false })
    backend.start(kept.id, 80, 24)
    backend.kill(kept.id, false)
    expect(terminals.processes[1].killed).toBe(true)
    expect(fs.existsSync(recordFile(kept.id))).toBe(true)
  })
})

describe('a Claude session', () => {
  it('asks the MCP config port for its file and launches with it, its hooks under the data directory', () => {
    const session = backend.spawn(cwd, { tmuxMode: false })
    expect(mcpConfig.write).toHaveBeenCalledExactlyOnceWith(session.id)
    expect(session.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/)
    backend.start(session.id, 80, 24)
    // The wrapper quotes every token for the shell; the assertions read it as such.
    const command = terminals.processes[0].spec.args.join(' ')
    expect(command).toContain(
      `'--mcp-config' '${path.join(dir, 'mcp-configs', `${session.id}.json`)}'`
    )
    expect(command).toContain(`'--session-id' '${session.claudeSessionId}'`)
    expect(command).toContain(path.join(dir, 'agent-state', `${session.id}.state`))
    expect(command).toContain(`CLAVE_SESSION_ID='${session.id}'`)
  })

  it('starts without the flag when there is no MCP server to point at', () => {
    mcpConfig.write.mockReturnValue(null)
    const session = backend.spawn(cwd, { tmuxMode: false })
    backend.start(session.id, 80, 24)
    expect(terminals.processes[0].spec.args.join(' ')).not.toContain('--mcp-config')
  })

  it('lets go of the config on a real close and keeps it on a quit', () => {
    const closed = backend.spawn(cwd, { tmuxMode: false })
    backend.kill(closed.id)
    expect(mcpConfig.remove).toHaveBeenCalledExactlyOnceWith(closed.id)
    const kept = backend.spawn(cwd, { tmuxMode: false })
    backend.kill(kept.id, false)
    expect(mcpConfig.remove).toHaveBeenCalledTimes(1)
  })
})

describe('the session records', () => {
  it('are rewritten on a rename, a view, a workspace and a window re-stamp, and read back as persisted', () => {
    const session = backend.spawn(cwd, { claudeMode: false, tmuxMode: false, workspaceId: 'ws-1' })
    backend.setSessionDisplayName(session.id, 'My tab', true)
    backend.setSessionViewRecord(session.id, { url: 'http://127.0.0.1:4792', title: 'Page' })
    backend.setSessionWorkspace(session.id, 'ws-2')
    backend.setSessionWindowKey(session.id, 'win-b')
    expect(readRecord(session.id)).toMatchObject({
      displayName: 'My tab',
      userRenamed: true,
      view: { url: 'http://127.0.0.1:4792', title: 'Page' },
      workspaceId: 'ws-2',
      windowKey: 'win-b'
    })
    expect(backend.getSessionRecord(session.id)).toEqual(readRecord(session.id))
    backend.setSessionViewRecord(session.id, null)
    expect(readRecord(session.id).view).toBeUndefined()
  })

  it('come back as adoptable after a quit, with the name kept, and a malformed or homeless record is pruned', () => {
    const session = backend.spawn(cwd, { claudeMode: false, tmuxMode: false })
    backend.setSessionDisplayName(session.id, 'Kept', true)
    backend.kill(session.id, false)
    fs.writeFileSync(recordFile('11111111-1111-4111-8111-111111111111'), '{not json')
    fs.writeFileSync(
      recordFile('22222222-2222-4222-8222-222222222222'),
      JSON.stringify({
        id: '22222222-2222-4222-8222-222222222222',
        cwd: path.join(dir, 'gone'),
        folderName: 'gone',
        claudeMode: false
      })
    )
    const adoptable = backend.listAdoptableSessions()
    expect(adoptable.map((r) => r.id)).toEqual([session.id])
    expect(adoptable[0]).toMatchObject({ displayName: 'Kept', live: false })
    expect(fs.readdirSync(path.join(dir, SESSION_RECORDS_FOLDER))).toEqual([`${session.id}.json`])

    // Adopting it reuses the id and carries the name forward.
    const back = backend.spawn(cwd, {
      claudeMode: false,
      tmuxMode: false,
      adoptSessionId: session.id
    })
    expect(back.id).toBe(session.id)
    expect(readRecord(session.id).displayName).toBe('Kept')
    expect(backend.listAdoptableSessions()).toEqual([])
  })

  it('a chat tab’s record is written through the same port and discarded by key', () => {
    const id = '33333333-3333-4333-8333-333333333333'
    expect(
      backend.writeEventSessionRecord({
        id,
        adapterId: 'claude-chat',
        transport: 'events',
        cwd,
        folderName: 'x',
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false
      })
    ).toBe(true)
    expect(readRecord(id).adapterId).toBe('claude-chat')
    backend.discardSessionRecord(id)
    expect(fs.existsSync(recordFile(id))).toBe(false)
    expect(backend.discardSessionRecord('../escape')).toBeUndefined()
  })

  it('move from the legacy folder once, on the first use of the records', () => {
    const legacy = path.join(dir, 'clave-tmux-sessions')
    fs.mkdirSync(legacy, { recursive: true })
    const id = '44444444-4444-4444-8444-444444444444'
    fs.writeFileSync(
      path.join(legacy, `${id}.json`),
      JSON.stringify({ id, cwd, folderName: 'x', claudeMode: false })
    )
    const fresh = new PtyBackend()
    expect(fresh.listAdoptableSessions().map((r) => r.id)).toEqual([id])
    expect(fs.existsSync(legacy)).toBe(false)
    expect(fs.existsSync(recordFile(id))).toBe(true)
  })
})
