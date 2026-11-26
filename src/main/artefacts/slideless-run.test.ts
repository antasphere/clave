import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { ArtefactRefusal } from './refusal'
import {
  runFailure,
  runSlideless,
  STDERR_LIMIT,
  STDOUT_LIMIT,
  withoutSecret,
  type SlidelessRunDeps
} from './slideless-run'
import {
  answer,
  CLI_PATH,
  EXEC_PATH,
  fakeSlideless,
  flush,
  SERVER_ENV
} from './slideless.test-support'

/**
 * One run of Clave's own copy of Slideless (PRDCT-4266), over a fake spawn:
 * Electron's Node runs the copy's script with the arguments after it, in the
 * server's own environment and `ELECTRON_RUN_AS_NODE`, every stream a pipe;
 * the input is written then closed, or closed at once; the output is kept to
 * its tail; a run past its time is killed; nothing is ever logged.
 */
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a run of Slideless', () => {
  it('runs the copy under Electron’s Node, in the server’s own environment, every stream a pipe', async () => {
    const slideless = fakeSlideless((_args, child) => answer('{"ok":true}')(child))
    const run = await slideless.run(['--json', 'profiles'], { timeoutMs: 15_000 })
    expect(run).toEqual({ code: 0, stdout: '{"ok":true}', stderr: '', timedOut: false })
    const [call] = slideless.calls
    expect(call!.command).toBe(EXEC_PATH)
    expect(call!.script).toBe(CLI_PATH)
    expect(call!.args).toEqual(['--json', 'profiles'])
    // Exactly the server's own variables and the one that makes the app a Node: nothing else.
    expect(call!.options.env).toEqual({ ...SERVER_ENV, ELECTRON_RUN_AS_NODE: '1' })
    expect(call!.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(call!.options.cwd).toBeUndefined()
    await slideless.run(['push', '/work/deck'], { cwd: '/work/deck', timeoutMs: 1000 })
    expect(slideless.calls[1]!.options.cwd).toBe('/work/deck')
  })

  it('writes the input then closes it, and closes it at once when there is none', async () => {
    const slideless = fakeSlideless((_args, child) => answer('')(child))
    await slideless.run(['login', '--api-key-stdin'], { input: 'slk_secret\n', timeoutMs: 1000 })
    await slideless.run(['--json', 'profiles'], { timeoutMs: 1000 })
    const [withInput, without] = slideless.calls
    expect(withInput!.child.stdin.written).toBe('slk_secret\n')
    expect(withInput!.child.stdin.ended).toBe(true)
    expect(withInput!.args).not.toContain('slk_secret')
    expect(without!.child.stdin.written).toBe('')
    expect(without!.child.stdin.ended).toBe(true)
  })

  it('keeps the tail of what it printed: 64 KB of output, 8 KB of errors', async () => {
    const slideless = fakeSlideless((_args, child) => {
      child.print('x'.repeat(STDOUT_LIMIT))
      child.print('END-OF-OUTPUT')
      child.say('e'.repeat(STDERR_LIMIT))
      child.say('END-OF-ERRORS')
      child.exit(1)
    })
    const run = await slideless.run(['push'], { timeoutMs: 1000 })
    expect(run.code).toBe(1)
    expect(Buffer.byteLength(run.stdout)).toBe(STDOUT_LIMIT)
    expect(run.stdout.endsWith('END-OF-OUTPUT')).toBe(true)
    expect(Buffer.byteLength(run.stderr)).toBe(STDERR_LIMIT)
    expect(run.stderr.endsWith('END-OF-ERRORS')).toBe(true)
  })

  it('kills a run past its time and says so', async () => {
    vi.useFakeTimers()
    const slideless = fakeSlideless()
    const running = slideless.run(['push'], { timeoutMs: 120_000 })
    await flush()
    vi.advanceTimersByTime(119_999)
    expect(slideless.calls[0]!.child.killedWith).toBeNull()
    vi.advanceTimersByTime(1)
    expect(slideless.calls[0]!.child.killedWith).toBe('SIGKILL')
    const run = await running
    expect(run).toMatchObject({ code: null, timedOut: true })
    expect(runFailure(run)).toBe('Slideless did not answer in time.')
  })

  it('refuses with the copy’s own sentence when it is not ready, and spawns nothing', async () => {
    const slideless = fakeSlideless(() => {}, {
      cli: () => {
        throw new ArtefactRefusal('Slideless is not installed on this server.')
      }
    })
    await expect(slideless.run(['--json', 'profiles'], { timeoutMs: 1000 })).rejects.toThrow(
      'Slideless is not installed on this server.'
    )
    expect(slideless.calls).toEqual([])
  })

  it('answers a child that could not start with its reason, and never the arguments', async () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdin = Object.assign(new EventEmitter(), { end: () => {} })
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    const deps: SlidelessRunDeps = {
      execPath: EXEC_PATH,
      env: SERVER_ENV,
      cli: () => ({ cliPath: CLI_PATH, version: '0.15.0', override: false }),
      spawn: () => {
        queueMicrotask(() => child.emit('error', new Error(`spawn ${EXEC_PATH} EACCES`)))
        return child as unknown as ChildProcess
      }
    }
    const run = await runSlideless(deps, ['login', '--email', 'someone@example.test'], {
      timeoutMs: 1000
    })
    expect(run.code).toBeNull()
    expect(run.stderr).toContain('EACCES')
    expect(run.stderr).not.toContain('someone@example.test')
  })

  it('logs nothing: not its arguments, not its input', async () => {
    const said = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'info')
    ]
    const slideless = fakeSlideless((_args, child) => answer('', 1, 'Error: refused\n')(child))
    await slideless.run(['--api-url', 'https://decks.example.test', 'login', '--api-key-stdin'], {
      input: 'slk_secret\n',
      timeoutMs: 1000
    })
    for (const spy of said) expect(spy).not.toHaveBeenCalled()
  })
})

describe('what a failed run says', () => {
  it('is the first error line, else how the command ended', () => {
    expect(
      runFailure({ code: 1, stdout: '', stderr: '\nError: no such deck\nmore\n', timedOut: false })
    ).toBe('no such deck')
    expect(runFailure({ code: 3, stdout: '', stderr: '', timedOut: false })).toBe(
      'Slideless stopped with exit code 3.'
    )
  })

  it('never carries a secret the command repeated', () => {
    expect(withoutSecret('Error: slk_abcdef is not valid', 'slk_abcdef')).toBe(
      'Error: [hidden] is not valid'
    )
    expect(withoutSecret('Error: refused', 'slk_abcdef')).toBe('Error: refused')
    expect(withoutSecret('Error: a b c', undefined)).toBe('Error: a b c')
  })
})
