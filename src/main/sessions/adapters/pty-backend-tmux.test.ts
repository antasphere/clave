import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * The tmux half of the backend, with every tmux call intercepted: what the
 * backend asks of tmux is the contract the sidebar's rehoming (lane C's
 * `rehomeSessions`) and the app's quit rely on. `kill(id, false)` kills the
 * CLIENT and keeps the tmux session and the record (a tab moved to another
 * window, or a quit, reattaches to it); `kill(id)` destroys the session and
 * drops the record. Silent if wrong: a detach that killed the session would
 * show as a tab that comes back empty in the other window.
 */
const calls = vi.hoisted(() => ({ execFile: [] as string[][], execFileSync: [] as string[][] }))
vi.mock('child_process', async (original) => {
  const real = await original<typeof import('child_process')>()
  return {
    ...real,
    execFile: vi.fn((file: string, args: string[], ...rest: unknown[]) => {
      calls.execFile.push([file, ...args])
      const cb = rest.find((r) => typeof r === 'function') as ((err: null) => void) | undefined
      cb?.(null)
      return { on: () => {} }
    }),
    // No live tmux sessions, no login shell: the backend falls back to this
    // process's environment, where tmux is found on the PATH or the suite skips.
    execFileSync: vi.fn((file: string, args: string[]) => {
      calls.execFileSync.push([file, ...args])
      return ''
    })
  }
})

import { installSettingsPorts, resetSettingsPorts } from '../../ports/registry'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import { fileStorage } from '../../ports/storage'
import type { TerminalPort, TerminalProcess } from '../../ports/terminal'
import { electronTestPorts, tempDataDir } from '../../ports/testing'
import {
  PtyBackend,
  SESSION_RECORDS_FOLDER,
  TMUX_CONFIG_DOCUMENT,
  isTmuxAvailable
} from './pty-backend'
import { tmuxKillSessionArgs } from '../../tmux-args'

let dir: string
let backend: PtyBackend
const processes: { killed: boolean; spec: { file: string; args: readonly string[] } }[] = []
const terminals: TerminalPort = {
  spawn(spec) {
    const p = { killed: false, spec }
    processes.push(p)
    const proc: TerminalProcess = {
      pid: 1,
      write: () => {},
      resize: () => {},
      kill: () => {
        p.killed = true
      },
      onData: () => () => {},
      onExit: () => () => {}
    }
    return proc
  }
}
const cwd = fs.realpathSync(tempDataDir('clave-pty-tmux-cwd-'))

beforeEach(() => {
  dir = tempDataDir()
  installSettingsPorts(electronTestPorts(dir))
  installTerminalPorts({ storage: fileStorage(dir), terminals })
  backend = new PtyBackend()
  calls.execFile.length = 0
  calls.execFileSync.length = 0
  processes.length = 0
})
afterEach(() => {
  resetTerminalPorts()
  resetSettingsPorts()
})

const killSessionCalls = (): string[][] => calls.execFile.filter((c) => c.includes('kill-session'))

describe.skipIf(!isTmuxAvailable())('a tmux-backed terminal', () => {
  it('is planned as a tmux client on the app’s socket, with the config written through the storage port', () => {
    const session = backend.spawn(cwd, { claudeMode: false, tmuxMode: true })
    expect(session.tmuxName).toMatch(/^clave-/)
    expect(fs.existsSync(path.join(dir, SESSION_RECORDS_FOLDER, `${session.tmuxName}.json`))).toBe(
      true
    )
    expect(fs.readFileSync(path.join(dir, TMUX_CONFIG_DOCUMENT), 'utf-8')).toContain(
      'set -g destroy-unattached off'
    )
    backend.start(session.id, 80, 24)
    const { file, args } = processes[0].spec
    expect(file).toMatch(/tmux$/)
    expect(args.slice(0, 3)).toEqual(['-u', '-L', 'clave'])
    expect(args).toContain('-f')
    expect(args[args.indexOf('-f') + 1]).toBe(path.join(dir, TMUX_CONFIG_DOCUMENT))
    expect(args).toContain('new-session')
    expect(args[args.indexOf('-s') + 1]).toBe(session.tmuxName)
  })

  it('a detach (kill with false) kills the client only: the tmux session and the record survive', () => {
    const session = backend.spawn(cwd, { claudeMode: false, tmuxMode: true })
    backend.start(session.id, 80, 24)
    backend.kill(session.id, false)
    expect(processes[0].killed).toBe(true)
    expect(killSessionCalls()).toEqual([])
    expect(fs.existsSync(path.join(dir, SESSION_RECORDS_FOLDER, `${session.tmuxName}.json`))).toBe(
      true
    )
    expect(backend.getSession(session.id)).toBeUndefined()
  })

  it('a real close destroys the tmux session and drops the record', () => {
    const session = backend.spawn(cwd, { claudeMode: false, tmuxMode: true })
    backend.start(session.id, 80, 24)
    backend.kill(session.id)
    expect(processes[0].killed).toBe(true)
    const [call] = killSessionCalls()
    expect(call?.slice(1)).toEqual(tmuxKillSessionArgs('clave', session.tmuxName!))
    expect(fs.existsSync(path.join(dir, SESSION_RECORDS_FOLDER, `${session.tmuxName}.json`))).toBe(
      false
    )
  })

  it('an adoption reattaches by the exact name, carrying the tab’s name forward', () => {
    const first = backend.spawn(cwd, { claudeMode: false, tmuxMode: true })
    backend.setSessionDisplayName(first.id, 'Kept across windows', true)
    backend.kill(first.id, false)
    const back = backend.spawn(cwd, {
      claudeMode: false,
      tmuxMode: true,
      adoptTmuxName: first.tmuxName,
      adoptSessionId: first.id
    })
    expect(back.id).toBe(first.id)
    expect(back.tmuxName).toBe(first.tmuxName)
    backend.start(back.id, 80, 24)
    expect(processes[0].spec.args).toContain('-A')
    expect(backend.getSessionRecord(back.id)?.displayName).toBe('Kept across windows')
  })

  // An Antigravity terminal a chat moved to: the conversation is on its
  // command line and its record, and a live reattach (which resumes nothing)
  // keeps it, so the tab can still go back to its chat.
  it('an Antigravity terminal resumes its conversation and keeps it across a live reattach', () => {
    const conversation = '70ec1049-f3e9-46a9-bd24-382267964044'
    const first = backend.spawn(cwd, {
      claudeMode: false,
      antigravityMode: true,
      tmuxMode: true,
      resumeSessionId: conversation
    })
    backend.start(first.id, 80, 24)
    expect(processes[0].spec.args.join(' ')).toContain(`'--conversation' '${conversation}'`)
    expect(backend.getSessionRecord(first.id)?.antigravitySessionId).toBe(conversation)
    backend.kill(first.id, false)
    backend.spawn(cwd, {
      claudeMode: false,
      antigravityMode: true,
      tmuxMode: true,
      adoptTmuxName: first.tmuxName,
      adoptSessionId: first.id
    })
    expect(backend.getSessionRecord(first.id)?.antigravitySessionId).toBe(conversation)
  })

  it('an Antigravity terminal runs the mode resolved, and records what was said', () => {
    const asked = backend.spawn(cwd, {
      claudeMode: false,
      antigravityMode: true,
      tmuxMode: true,
      antigravityLaunchMode: 'default',
      effort: 'low',
      permissionDefault: 'default'
    })
    backend.start(asked.id, 80, 24)
    const command = processes[0].spec.args.join(' ')
    expect(command).toContain(`'--settings' '{"agentMode":""}'`)
    expect(command).not.toContain('--mode')
    expect(backend.getSessionRecord(asked.id)).toMatchObject({
      effort: 'low',
      permissionDefault: 'default'
    })
    expect(backend.getSessionRecord(asked.id)?.permissionMode).toBeUndefined()
    backend.kill(asked.id, false)

    const planned = backend.spawn(cwd, {
      claudeMode: false,
      antigravityMode: true,
      tmuxMode: true,
      antigravityLaunchMode: 'plan',
      permissionMode: 'plan'
    })
    backend.start(planned.id, 80, 24)
    expect(processes[1].spec.args.join(' ')).toContain(`'--mode' 'plan'`)
    expect(backend.getSessionRecord(planned.id)?.permissionMode).toBe('plan')
    backend.kill(planned.id, false)
    backend.spawn(cwd, {
      claudeMode: false,
      antigravityMode: true,
      tmuxMode: true,
      adoptTmuxName: planned.tmuxName,
      adoptSessionId: planned.id
    })
    expect(backend.getSessionRecord(planned.id)?.permissionMode).toBe('plan')
  })

  it('hands an Antigravity terminal in Ask the copy of its settings file', () => {
    const asked = backend.spawn(cwd, {
      claudeMode: false,
      antigravityMode: true,
      tmuxMode: true,
      launchProfile: {
        id: 'agy-file',
        name: 'Agy file',
        family: 'antigravity',
        command: ['agy'],
        additionalArgs: ['--settings', 'rules.json']
      },
      antigravityLaunchMode: 'default',
      antigravityAskSettings: '/private/ask.json'
    })
    backend.start(asked.id, 80, 24)
    expect(processes[0].spec.args.join(' ')).toContain(`'--settings' '/private/ask.json'`)
  })

  it('an OpenCode terminal keeps its session across a live reattach too', () => {
    // No tool server: the tab starts without Clave's tools.
    installTerminalPorts({ mcpConfig: { write: () => null, remove: () => {} } })
    const first = backend.spawn(cwd, {
      claudeMode: false,
      opencodeMode: true,
      tmuxMode: true,
      resumeSessionId: 'ses_0123456789abcdef'
    })
    backend.kill(first.id, false)
    backend.spawn(cwd, {
      claudeMode: false,
      opencodeMode: true,
      tmuxMode: true,
      adoptTmuxName: first.tmuxName,
      adoptSessionId: first.id
    })
    expect(backend.getSessionRecord(first.id)?.opencodeSessionId).toBe('ses_0123456789abcdef')
  })
})
