import { describe, expect, it } from 'vitest'
import {
  ENV_COMMAND,
  ENV_MARK,
  cachedLoginEnv,
  forgetLoginEnv,
  loginShellEnv,
  mergePaths,
  parseEnv0,
  parseMarkedEnv,
  type ExecLike
} from './login-env'

describe('the login shell environment', () => {
  it('parses env -0 output and merges path lists in order', () => {
    expect(parseEnv0('A=1\0B=x=y\0junk\0')).toEqual({ A: '1', B: 'x=y' })
    expect(mergePaths('/own/bin:/usr/bin', '/login/bin:/usr/bin:')).toBe(
      '/own/bin:/usr/bin:/login/bin'
    )
  })

  it('takes the login shell environment with the plugin path first', async () => {
    const calls: { file: string; args: string[]; killSignal: string | undefined }[] = []
    const exec: ExecLike = (file, args, options, callback) => {
      calls.push({ file, args, killSignal: options.killSignal })
      callback(
        null,
        `${ENV_MARK}PATH=/login/bin:/usr/bin\0HOME=/Users/x\0SLIDELESS_PROFILE=share\0`,
        ''
      )
      return undefined
    }
    const env = await loginShellEnv(exec, {
      PATH: '/own/bin:/usr/bin',
      HOME: '/Users/x',
      TMPDIR: '/tmp/t'
    })
    expect(calls).toEqual([
      { file: '/bin/zsh', args: ['-lic', ENV_COMMAND], killSignal: 'SIGKILL' }
    ])
    expect(ENV_COMMAND).toBe(`printf '%s' '${ENV_MARK}'; env -0`)
    expect(env).toEqual({
      PATH: '/own/bin:/usr/bin:/login/bin',
      HOME: '/Users/x',
      TMPDIR: '/tmp/t',
      SLIDELESS_PROFILE: 'share'
    })
  })

  it('drops what a chatty profile prints before the mark, and takes nothing without it', async () => {
    const chatty: ExecLike = (_file, _args, _options, callback) => {
      callback(null, `Welcome, a line from .zshrc\n${ENV_MARK}PATH=/login/bin\0HOME=/Users/x\0`, '')
      return undefined
    }
    const env = await loginShellEnv(chatty, { PATH: '/own/bin:/usr/bin', HOME: '/Users/x' })
    expect(env['PATH']).toBe('/own/bin:/usr/bin:/login/bin')
    expect(Object.keys(env).some((key) => key.includes('\n'))).toBe(false)
    expect(parseMarkedEnv('no mark at all\nPATH=/x\0')).toEqual({})
    const unmarked: ExecLike = (_file, _args, _options, callback) => {
      callback(null, 'PATH=/login/bin\0', '')
      return undefined
    }
    const bare = await loginShellEnv(unmarked, { PATH: '/own/bin', HOME: '/Users/x' })
    expect(bare['PATH']).toBe('/own/bin')
  })

  it('resolves the shell once per process and again after it was forgotten', async () => {
    let runs = 0
    const exec: ExecLike = (_file, _args, _options, callback) => {
      runs++
      callback(null, `${ENV_MARK}PATH=/login/bin\0`, '')
      return undefined
    }
    forgetLoginEnv()
    const first = await cachedLoginEnv(exec, { PATH: '/own/bin' })
    const second = await cachedLoginEnv(exec, { PATH: '/own/bin' })
    expect(runs).toBe(1)
    expect(second).toBe(first)
    forgetLoginEnv()
    await cachedLoginEnv(exec, { PATH: '/own/bin' })
    expect(runs).toBe(2)
    forgetLoginEnv()
  })

  it('keeps the plugin path when the shell fails or throws', async () => {
    const exec: ExecLike = (_file, _args, _options, callback) => {
      callback(new Error('zsh failed'), '', '')
      return undefined
    }
    const env = await loginShellEnv(exec, { PATH: '/own/bin:/usr/bin', HOME: '/Users/x' })
    expect(env['PATH']).toBe('/own/bin:/usr/bin')
    expect(env['HOME']).toBe('/Users/x')
    const throwing: ExecLike = () => {
      throw new Error('no shell')
    }
    const same = await loginShellEnv(throwing, { PATH: '/own/bin', TMPDIR: '/tmp/t' })
    expect(same).toEqual({ PATH: '/own/bin', TMPDIR: '/tmp/t' })
  })
})
