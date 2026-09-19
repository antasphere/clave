import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConversationClient } from './client'
import {
  restartConversationService,
  type RestartConversationServiceOptions,
  type RestartDependencies,
  type RestartPeer,
  type RestartProcessIdentity
} from './restart'
import { servicePaths } from './wire'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Preserve Vitest's inferred mock signatures for assertions and per-test overrides.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(capabilities: string[] = []) {
  const userData = mkdtempSync(join(tmpdir(), 'clave-restart-test-'))
  directories.push(userData)
  const paths = servicePaths(userData)
  mkdirSync(paths.directory, { mode: 0o700 })
  writeFileSync(paths.token, 'test-only-token', { mode: 0o600 })
  const ownerPath = join(paths.directory, 'owner.json')
  writeFileSync(ownerPath, JSON.stringify({ pid: 45678 }), { mode: 0o600 })
  const recordPath = join(paths.directory, 'record-fixture.json')
  writeFileSync(recordPath, '{"retained":"history"}')
  let connected = true
  let identity: RestartProcessIdentity | null = {
    uid: process.getuid?.() ?? 1000,
    started: 'Mon Jan 12 10:00:00 2026',
    command: `/test/electron /test/conversation-daemon.js --conversation-daemon ${userData}`
  }
  const peer = {
    getServerInfo: vi.fn(() => ({ protocolVersion: 2, capabilities })),
    list: vi.fn(async () => [{ status: 'idle' }, { status: 'running' }, { status: 'closed' }]),
    shutdown: vi.fn(async () => {
      connected = false
    }),
    isConnected: vi.fn(() => connected),
    disconnect: vi.fn(() => {
      connected = false
    })
  } satisfies RestartPeer
  const options = {
    userData,
    daemonPath: '/test/conversation-daemon.js',
    executablePath: '/test/electron',
    confirm: vi.fn(async () => true),
    disconnect: vi.fn(),
    reconnect: vi.fn(async () => {})
  } satisfies RestartConversationServiceOptions
  const deps = {
    platform: 'darwin',
    uid: process.getuid?.() ?? 1000,
    attach: vi.fn<RestartDependencies['attach']>(async () => peer),
    inspect: vi.fn<RestartDependencies['inspect']>(async () => identity),
    signal: vi.fn(() => {
      connected = false
      identity = null
    }),
    resourcesReleased: vi.fn(async () => true),
    sleep: vi.fn(async () => {}),
    stopTimeoutMs: 0
  } satisfies RestartDependencies
  return {
    options,
    deps,
    peer,
    paths,
    ownerPath,
    recordPath,
    setIdentity: (value: RestartProcessIdentity | null) => {
      identity = value
    },
    identity: () => identity!,
    drop: () => {
      connected = false
    }
  }
}

describe('profile-specific service restart', () => {
  it.skipIf(process.platform === 'win32')(
    'restarts only an actual test-owned legacy child',
    async () => {
      const f = fixture()
      mkdirSync(f.paths.socketDirectory, { mode: 0o700 })
      directories.push(f.paths.socketDirectory)
      const daemonPath = resolve('src/main/conversations/fixtures/restart-daemon.mjs')
      const child = spawn(
        process.execPath,
        [daemonPath, '--conversation-daemon', f.options.userData],
        {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, TEST_CONVERSATION_SOCKET: f.paths.socket }
        }
      )
      const exited = once(child, 'exit')
      try {
        await new Promise<void>((resolveReady, reject) => {
          const timeout = setTimeout(() => reject(new Error('Test child did not start')), 3000)
          child.once('message', () => {
            clearTimeout(timeout)
            resolveReady()
          })
          child.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
          })
          child.once('exit', () => {
            clearTimeout(timeout)
            reject(new Error('Test child exited before ready'))
          })
        })
        const options = { ...f.options, daemonPath, executablePath: process.execPath }
        expect(
          await restartConversationService(options, {
            attach: async (socket, token, version) => {
              const client = await ConversationClient.attach(socket, token, version)
              return {
                getServerInfo: () => ({ protocolVersion: version, capabilities: [] }),
                list: () => client.list(),
                isConnected: () => client.isConnected(),
                disconnect: () => client.disconnect(),
                shutdown: async () => {
                  throw new Error('Legacy peer has no shutdown')
                }
              }
            }
          })
        ).toBe(true)
        expect(await exited).toEqual([0, null])
        expect(options.confirm).toHaveBeenCalledWith({
          userData: options.userData,
          openConversations: 1,
          method: 'signal'
        })
        expect(options.reconnect).toHaveBeenCalledOnce()
        expect(readFileSync(f.recordPath, 'utf8')).toBe('{"retained":"history"}')
      } finally {
        // Exact test child only. No process matching and no force escalation.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await exited
      }
    }
  )

  it('signals only the verified legacy PID after native confirmation and preserves files', async () => {
    const f = fixture()
    const order: string[] = []
    f.options.confirm.mockImplementation(async () => {
      order.push('confirm')
      return true
    })
    f.options.disconnect.mockImplementation(() => {
      order.push('invalidate')
    })
    f.options.reconnect.mockImplementation(async () => {
      order.push('connect')
    })
    const before = [f.paths.token, f.ownerPath, f.recordPath].map((file) =>
      readFileSync(file, 'utf8')
    )
    expect(await restartConversationService(f.options, f.deps)).toBe(true)
    expect(f.options.confirm).toHaveBeenCalledWith({
      userData: f.options.userData,
      openConversations: 2,
      method: 'signal'
    })
    expect(f.deps.signal).toHaveBeenCalledExactlyOnceWith(45678)
    expect(f.peer.shutdown).not.toHaveBeenCalled()
    expect(f.deps.inspect.mock.calls.every(([pid]) => pid === 45678)).toBe(true)
    expect(order).toEqual(['confirm', 'invalidate', 'connect'])
    expect(
      [f.paths.token, f.ownerPath, f.recordPath].map((file) => readFileSync(file, 'utf8'))
    ).toEqual(before)
  })

  it('probes v2 and then v1 without launching any replacement before authentication', async () => {
    const f = fixture()
    f.deps.attach.mockRejectedValueOnce(new Error('handshake rejected'))
    expect(await restartConversationService(f.options, f.deps)).toBe(true)
    expect(f.deps.attach.mock.calls).toEqual([
      [f.paths.socket, 'test-only-token', 2],
      [f.paths.socket, 'test-only-token', 1]
    ])
  })

  it('cancellation does not stop the service or invalidate the cache', async () => {
    const f = fixture(['shutdown'])
    f.options.confirm.mockResolvedValue(false)
    expect(await restartConversationService(f.options, f.deps)).toBe(false)
    expect(f.deps.signal).not.toHaveBeenCalled()
    expect(f.peer.shutdown).not.toHaveBeenCalled()
    expect(f.options.disconnect).not.toHaveBeenCalled()
    expect(f.options.reconnect).not.toHaveBeenCalled()
  })

  it('does nothing destructive on authentication failure', async () => {
    const f = fixture()
    f.deps.attach.mockRejectedValue(new Error('test-only-token must not escape in error'))
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow(
      'Could not authenticate the selected conversation service. Nothing was stopped.'
    )
    expect(f.options.confirm).not.toHaveBeenCalled()
    expect(f.deps.inspect).not.toHaveBeenCalled()
    expect(f.deps.signal).not.toHaveBeenCalled()
    expect(f.options.reconnect).not.toHaveBeenCalled()
  })

  it.each(['missing', 'other user', 'other profile', 'other script', 'extra argument'])(
    'refuses %s owner',
    async (reason) => {
      const f = fixture()
      const identity = { ...f.identity() }
      if (reason === 'other user') identity.uid++
      if (reason === 'other profile') identity.command += '-another'
      if (reason === 'other script')
        identity.command = identity.command.replace('conversation-daemon.js', 'other.js')
      if (reason === 'extra argument') identity.command += ' --unrelated'
      f.setIdentity(reason === 'missing' ? null : identity)
      await expect(restartConversationService(f.options, f.deps)).rejects.toThrow('Cannot verify')
      expect(f.options.confirm).not.toHaveBeenCalled()
      expect(f.deps.signal).not.toHaveBeenCalled()
      expect(f.options.reconnect).not.toHaveBeenCalled()
    }
  )

  it('refuses a recycled PID after the prompt', async () => {
    const f = fixture()
    f.options.confirm.mockImplementation(async () => {
      f.setIdentity({ ...f.identity(), started: 'Mon Jan 12 11:00:00 2026' })
      return true
    })
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow(
      'changed during confirmation'
    )
    expect(f.deps.signal).not.toHaveBeenCalled()
    expect(f.options.reconnect).not.toHaveBeenCalled()
  })

  it('refuses changed private owner metadata after the prompt', async () => {
    const f = fixture()
    f.options.confirm.mockImplementation(async () => {
      writeFileSync(f.ownerPath, JSON.stringify({ pid: 56789 }))
      return true
    })
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow(
      'changed during confirmation'
    )
    expect(f.deps.signal).not.toHaveBeenCalled()
  })

  it('requires the original authenticated peer to survive confirmation', async () => {
    const f = fixture()
    f.options.confirm.mockImplementation(async () => {
      f.drop()
      return true
    })
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow('disconnected')
    expect(f.deps.signal).not.toHaveBeenCalled()
    expect(f.options.reconnect).not.toHaveBeenCalled()
  })

  it('refuses nonprivate metadata', async () => {
    const f = fixture()
    chmodSync(f.ownerPath, 0o644)
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow('Unsafe')
    expect(f.deps.signal).not.toHaveBeenCalled()
  })

  it('prefers advertised shutdown, even on Windows, without inspecting or signaling a process', async () => {
    const f = fixture(['shutdown'])
    expect(await restartConversationService(f.options, { ...f.deps, platform: 'win32' })).toBe(true)
    expect(f.peer.shutdown).toHaveBeenCalledOnce()
    expect(f.deps.inspect).not.toHaveBeenCalled()
    expect(f.deps.signal).not.toHaveBeenCalled()
    expect(f.options.reconnect).toHaveBeenCalledOnce()
  })

  it('refuses Windows legacy fallback', async () => {
    const f = fixture()
    await expect(
      restartConversationService(f.options, { ...f.deps, platform: 'win32' })
    ).rejects.toThrow('platform')
    expect(f.deps.signal).not.toHaveBeenCalled()
  })

  it('a lost shutdown acknowledgement is safe only after observed release', async () => {
    const f = fixture(['shutdown'])
    f.peer.shutdown.mockImplementation(async () => {
      f.drop()
      throw new Error('disconnected')
    })
    expect(await restartConversationService(f.options, f.deps)).toBe(true)
    expect(f.deps.resourcesReleased).toHaveBeenCalledWith(f.paths.socket)
    expect(f.options.reconnect).toHaveBeenCalledOnce()
  })

  it.each(['connected', 'locked', 'owner alive'])(
    'never replaces an owner still %s',
    async (condition) => {
      const f = fixture(condition === 'owner alive' ? [] : ['shutdown'])
      if (condition === 'connected') f.peer.shutdown.mockImplementation(async () => {})
      if (condition === 'locked') f.deps.resourcesReleased.mockResolvedValue(false)
      if (condition === 'owner alive')
        f.deps.signal.mockImplementation(() => {
          f.drop()
        })
      await expect(restartConversationService(f.options, f.deps)).rejects.toThrow(
        'has not released'
      )
      expect(f.options.disconnect).not.toHaveBeenCalled()
      expect(f.options.reconnect).not.toHaveBeenCalled()
    }
  )

  it('a signal failure never launches a replacement', async () => {
    const f = fixture()
    f.deps.signal.mockImplementation(() => {
      throw new Error('ESRCH')
    })
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow('Could not stop')
    expect(f.options.reconnect).not.toHaveBeenCalled()
  })

  it('clears the cached connection before attempting reconnect, even if reconnect fails', async () => {
    const f = fixture(['shutdown'])
    f.options.reconnect.mockImplementation(async () => {
      expect(f.options.disconnect).toHaveBeenCalledOnce()
      throw new Error('new build unavailable')
    })
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow(
      'new build could not connect'
    )
    expect(f.options.disconnect).toHaveBeenCalledTimes(2)
    // A later explicit action must not stay wedged behind the restart guard.
    f.deps.attach.mockRejectedValue(new Error('no owner'))
    await expect(restartConversationService(f.options, f.deps)).rejects.toThrow(
      'Could not authenticate'
    )
  })
})
