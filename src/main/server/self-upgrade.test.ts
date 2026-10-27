/**
 * The daemon's self-upgrade (issue #266): where its version and its install
 * facts come from, the idle gate, the install script's arguments and launch,
 * and the state a Mac reads. The runner here is a recording one, never a
 * real install; `scriptRunner` is exercised on a stand-in script that only
 * records what it was given.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { InvalidUpgradeVersion, type ServerUpgradeStatus } from '@clave/contract/server-info'
import {
  NOT_SCRIPT_INSTALLED,
  UPGRADE_IDLE_MS,
  createSelfUpgrade,
  redactSecrets,
  readInstallFacts,
  scriptRunner,
  serverVersion,
  sessionActivity,
  upgradeArgs,
  upgradeIdleMs,
  upgradeLaunch,
  type AgentActivity,
  type Clock,
  type RunResult,
  type SelfUpgrade,
  type UpgradeRunner
} from './self-upgrade'

const FACTS = {
  name: 'clave-server',
  script: '/home/u/.local/lib/clave-server/current/scripts/install-server.sh',
  ref: 'v3.0.0-beta.6'
}

/** A clock the test moves by hand. */
interface FakeClock extends Clock {
  advance(ms: number): void
  pending(): number
}
function fakeClock(start = 1_000): FakeClock {
  let now = start
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number)
    },
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    },
    pending: () => timers.size
  }
}

/** Agents whose working state the test sets. */
function fakeActivity(): AgentActivity & { set(count: number): void } {
  const listeners = new Set<() => void>()
  let working = 0
  return {
    busy: () => working > 0,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(count: number) {
      working = count
      for (const fn of [...listeners]) fn()
    }
  }
}

/** Records every run; each run ends when the test says so. */
interface Run {
  script: string
  args: string[]
  end: (r: RunResult) => void
  fail: (e: Error) => void
}
function recordingRunner(): { runner: UpgradeRunner; runs: Run[] } {
  const runs: Run[] = []
  const runner: UpgradeRunner = {
    start: ({ script, args }) =>
      new Promise<RunResult>((resolve, reject) => {
        runs.push({ script, args, end: resolve, fail: reject })
      })
  }
  return { runner, runs }
}

interface World {
  clock: FakeClock
  activity: ReturnType<typeof fakeActivity>
  runs: Run[]
  statuses: ServerUpgradeStatus[]
  upgrade: SelfUpgrade
}
function world(
  options: { facts?: typeof FACTS | { reason: string }; version?: string } = {}
): World {
  const clock = fakeClock()
  const activity = fakeActivity()
  const { runner, runs } = recordingRunner()
  const statuses: ServerUpgradeStatus[] = []
  const upgrade = createSelfUpgrade({
    version: options.version ?? '3.0.0-beta.6',
    facts: options.facts ?? FACTS,
    runner,
    activity,
    clock
  })
  upgrade.subscribe((status) => statuses.push(status))
  return { clock, activity, runs, statuses, upgrade }
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the version a server reports', () => {
  it('takes --app-version over the checkout package.json (a beta says 2.4.0 there)', () => {
    expect(serverVersion(['--daemon', '--app-version', '3.0.0-beta.9'], () => '2.4.0')).toBe(
      '3.0.0-beta.9'
    )
    expect(serverVersion(['--app-version=3.0.0-beta.9'], () => '2.4.0')).toBe('3.0.0-beta.9')
  })
  it('falls back to the checkout version without the flag', () => {
    expect(serverVersion(['--daemon'], () => '2.4.0')).toBe('2.4.0')
  })
})

describe('the install facts of a daemon', () => {
  it('reads the name, the script and the ref install-server.sh passes', () => {
    expect(
      readInstallFacts([
        '--daemon',
        '--install-name',
        FACTS.name,
        '--install-script',
        FACTS.script,
        '--install-ref',
        FACTS.ref
      ])
    ).toEqual(FACTS)
  })
  it.each([
    [['--daemon']],
    [['--daemon', '--install-name', 'clave-server', '--install-script', FACTS.script]],
    [['--daemon', '--install-name', 'clave-server', '--install-ref', 'v3.0.0']],
    [['--daemon', '--install-script', FACTS.script, '--install-ref', 'v3.0.0']]
  ])('is unsupported without all three: %j', (argv) => {
    expect(readInstallFacts(argv)).toEqual({ reason: NOT_SCRIPT_INSTALLED })
  })
  it('refuses a name the script would refuse, and a relative script', () => {
    const base = ['--daemon', '--install-ref', 'v3.0.0']
    expect(
      readInstallFacts([...base, '--install-name', 'Bad Name', '--install-script', FACTS.script])
    ).toHaveProperty('reason')
    expect(
      readInstallFacts([
        ...base,
        '--install-name',
        'ok',
        '--install-script',
        'scripts/install-server.sh'
      ])
    ).toHaveProperty('reason')
  })
})

describe('the install script run', () => {
  it('passes the name and the release tag of the version, and nothing else', () => {
    expect(upgradeArgs('clave-server', '3.0.0-beta.9')).toEqual([
      '--name',
      'clave-server',
      '--ref',
      'v3.0.0-beta.9'
    ])
  })

  it('runs outside the service on Linux, through systemd-run, with the service PATH', () => {
    const launch = upgradeLaunch('linux', {
      name: 'clave-server',
      copy: '/data/upgrade/install-server.sh',
      log: '/data/upgrade/upgrade.log',
      args: upgradeArgs('clave-server', '3.0.0'),
      path: '/usr/bin:/bin',
      home: '/home/u',
      epoch: 1700000000,
      systemdRun: '/usr/bin/systemd-run'
    })
    expect(launch).toEqual({
      command: '/usr/bin/systemd-run',
      args: [
        '--user',
        '--collect',
        '--wait',
        '--quiet',
        '--unit=clave-server-upgrade-1700000000',
        '--setenv=PATH=/usr/bin:/bin',
        '--working-directory=/home/u',
        '--property=StandardOutput=append:/data/upgrade/upgrade.log',
        '--property=StandardError=append:/data/upgrade/upgrade.log',
        '/bin/bash',
        '/data/upgrade/install-server.sh',
        '--name',
        'clave-server',
        '--ref',
        'v3.0.0'
      ],
      detached: false
    })
  })

  it('fails clearly on Linux without systemd-run, running nothing', () => {
    expect(
      upgradeLaunch('linux', {
        name: 'clave-server',
        copy: '/c',
        log: '/l',
        args: [],
        path: '/bin',
        home: '/h',
        epoch: 1,
        systemdRun: null
      })
    ).toEqual({ error: expect.stringContaining('systemd-run') })
  })

  it('runs in its own process group on macOS, so a launchctl bootout of the server spares it', () => {
    expect(
      upgradeLaunch('darwin', {
        name: 'clave-server',
        copy: '/data/upgrade/install-server.sh',
        log: '/l',
        args: upgradeArgs('clave-server', '3.0.0'),
        path: '/usr/bin',
        home: '/Users/u',
        epoch: 1,
        systemdRun: null
      })
    ).toEqual({
      command: '/bin/bash',
      args: ['/data/upgrade/install-server.sh', '--name', 'clave-server', '--ref', 'v3.0.0'],
      detached: true
    })
  })
})

describe('the idle window', () => {
  it('is a minute, overridable only by the test flag in test mode', () => {
    expect(UPGRADE_IDLE_MS).toBe(60_000)
    expect(upgradeIdleMs(['--test-upgrade-idle-ms', '500'], false)).toBe(60_000)
    expect(upgradeIdleMs(['--test-upgrade-idle-ms', '500'], true)).toBe(500)
    expect(upgradeIdleMs(['--test-upgrade-idle-ms', 'soon'], true)).toBe(60_000)
    expect(upgradeIdleMs([], true)).toBe(60_000)
  })
})

describe('the self-upgrade', () => {
  it('reports the version, the ref and the state', () => {
    const { upgrade } = world()
    expect(upgrade.info()).toEqual({
      version: '3.0.0-beta.6',
      installRef: 'v3.0.0-beta.6',
      upgrade: { supported: true, state: 'idle' }
    })
  })

  it('is unsupported on a daemon the script did not install', () => {
    const { upgrade, runs } = world({ facts: { reason: NOT_SCRIPT_INSTALLED } })
    expect(upgrade.info()).toEqual({
      version: '3.0.0-beta.6',
      installRef: null,
      upgrade: { supported: false, reason: NOT_SCRIPT_INSTALLED, state: 'idle' }
    })
    expect(() => upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })).toThrow(
      CapabilityUnavailable
    )
    expect(runs).toEqual([])
  })

  it('refuses a version a release tag cannot name, before anything runs', () => {
    const { upgrade, runs, clock } = world()
    for (const version of ['dev', 'v3.0.0', '3.0.0 --repo https://x', '--force', '3.0'])
      expect(() => upgrade.requestUpgrade({ version, when: 'now' })).toThrow(InvalidUpgradeVersion)
    clock.advance(UPGRADE_IDLE_MS * 2)
    expect(runs).toEqual([])
    expect(upgrade.info().upgrade.state).toBe('idle')
  })

  it('does nothing for the version it already runs', () => {
    const { upgrade, runs, clock } = world()
    expect(upgrade.requestUpgrade({ version: '3.0.0-beta.6', when: 'now' })).toEqual({
      supported: true,
      state: 'idle'
    })
    clock.advance(UPGRADE_IDLE_MS * 2)
    expect(runs).toEqual([])
  })

  it('waits for a full minute of no working agent, then runs the tag of the version', () => {
    const { upgrade, runs, clock } = world()
    expect(upgrade.requestUpgrade({ version: '3.0.0-beta.9', when: 'idle' })).toEqual({
      supported: true,
      state: 'waiting-for-idle',
      target: '3.0.0-beta.9',
      mode: 'when-idle',
      since: 1_000
    })
    clock.advance(UPGRADE_IDLE_MS - 1)
    expect(runs).toEqual([])
    clock.advance(1)
    expect(runs.map((r) => [r.script, r.args])).toEqual([
      [FACTS.script, ['--name', 'clave-server', '--ref', 'v3.0.0-beta.9']]
    ])
    expect(upgrade.info().upgrade).toMatchObject({
      state: 'running',
      target: '3.0.0-beta.9',
      mode: 'when-idle'
    })
  })

  it('restarts the count from zero when an agent works for a moment during it', () => {
    const { upgrade, runs, clock, activity } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'idle' })
    clock.advance(UPGRADE_IDLE_MS / 2)
    activity.set(1)
    clock.advance(1_000)
    activity.set(0)
    clock.advance(UPGRADE_IDLE_MS - 1)
    expect(runs).toEqual([])
    clock.advance(1)
    expect(runs).toHaveLength(1)
  })

  it('never starts while an agent works, and counts the minute from when the last one stops', () => {
    const { upgrade, runs, clock, activity } = world()
    activity.set(1)
    upgrade.requestUpgrade({ version: '3.0.0', when: 'idle' })
    clock.advance(UPGRADE_IDLE_MS * 10)
    expect(runs).toEqual([])
    activity.set(0)
    clock.advance(UPGRADE_IDLE_MS / 2)
    activity.set(2)
    clock.advance(UPGRADE_IDLE_MS)
    expect(runs).toEqual([])
    activity.set(0)
    clock.advance(UPGRADE_IDLE_MS - 1)
    expect(runs).toEqual([])
    clock.advance(1)
    expect(runs).toHaveLength(1)
  })

  it('starts at once when asked now, even with an agent working', () => {
    const { upgrade, runs, activity } = world()
    activity.set(1)
    expect(upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })).toMatchObject({
      state: 'running',
      target: '3.0.0',
      mode: 'now'
    })
    expect(runs.map((r) => r.args)).toEqual([['--name', 'clave-server', '--ref', 'v3.0.0']])
  })

  it('replaces the target of a wait, the idle count going on', () => {
    const { upgrade, runs, clock } = world()
    upgrade.requestUpgrade({ version: '3.0.0-beta.8', when: 'idle' })
    clock.advance(UPGRADE_IDLE_MS / 2)
    expect(upgrade.requestUpgrade({ version: '3.0.0-beta.9', when: 'idle' })).toMatchObject({
      state: 'waiting-for-idle',
      target: '3.0.0-beta.9'
    })
    clock.advance(UPGRADE_IDLE_MS / 2 - 1)
    expect(runs).toEqual([])
    clock.advance(1)
    expect(runs.map((r) => r.args[3])).toEqual(['v3.0.0-beta.9'])
  })

  it('a now cuts a wait short, and the wait never fires after it', () => {
    const { upgrade, runs, clock } = world()
    upgrade.requestUpgrade({ version: '3.0.0-beta.9', when: 'idle' })
    clock.advance(UPGRADE_IDLE_MS / 2)
    upgrade.requestUpgrade({ version: '3.0.0-beta.9', when: 'now' })
    expect(runs.map((r) => r.args[3])).toEqual(['v3.0.0-beta.9'])
    clock.advance(UPGRADE_IDLE_MS * 2)
    expect(runs).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  it('a change between states that are not working leaves the count alone', () => {
    const { upgrade, runs, clock, activity } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'idle' })
    clock.advance(UPGRADE_IDLE_MS - 10)
    activity.set(0)
    clock.advance(10)
    expect(runs).toHaveLength(1)
  })

  it('a request for the running version cancels a wait', () => {
    const { upgrade, runs, clock } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'idle' })
    expect(upgrade.requestUpgrade({ version: '3.0.0-beta.6', when: 'idle' })).toEqual({
      supported: true,
      state: 'idle',
      since: 1_000
    })
    clock.advance(UPGRADE_IDLE_MS * 2)
    expect(runs).toEqual([])
  })

  it('answers a request during a run with the run, and starts no second one', () => {
    const { upgrade, runs } = world()
    const running = upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    expect(upgrade.requestUpgrade({ version: '3.0.1', when: 'now' })).toEqual(running)
    expect(runs).toHaveLength(1)
  })

  it('reports a failed run with the end of its log, and keeps serving', async () => {
    const { upgrade, runs } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[0].end({ code: 1, tail: 'npm ERR! build failed' })
    await settle()
    expect(upgrade.info().upgrade).toMatchObject({
      state: 'failed',
      target: '3.0.0',
      error: 'npm ERR! build failed'
    })
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    expect(runs).toHaveLength(2)
  })

  it('reports a run that could not start as failed', async () => {
    const { upgrade, runs } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[0].fail(new Error('systemd-run is not available on this server'))
    await settle()
    expect(upgrade.info().upgrade).toMatchObject({
      state: 'failed',
      error: 'systemd-run is not available on this server'
    })
  })

  it('goes back to idle when the script exits 0 with the server still up', async () => {
    const { upgrade, runs } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[0].end({ code: 0, tail: 'Already on v3.0.0' })
    await settle()
    expect(upgrade.info().upgrade).toEqual({ supported: true, state: 'idle', since: 1_000 })
  })

  it('tells its subscribers every change', async () => {
    const { upgrade, runs, clock, statuses } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'idle' })
    clock.advance(UPGRADE_IDLE_MS)
    runs[0].end({ code: 2, tail: 'boom' })
    await settle()
    expect(statuses.map((s) => s.state)).toEqual(['waiting-for-idle', 'running', 'failed'])
  })

  it('stops waiting when closed', () => {
    const { upgrade, runs, clock } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'idle' })
    upgrade.close()
    clock.advance(UPGRADE_IDLE_MS * 2)
    expect(runs).toEqual([])
  })
})

describe('the agents the gate watches', () => {
  it('is busy while any session is working, and hears state changes, additions and removals', () => {
    let states: Array<'idle' | 'working' | 'done' | 'blocked' | 'ended'> = ['idle', 'working']
    let onStream: ((id: string, stream: unknown) => void) | undefined
    let onRemoved: ((id: string) => void) | undefined
    let onAdded: (() => void) | undefined
    const activity = sessionActivity({
      list: () => states.map((state, i) => ({ id: `s${i}`, state })) as never,
      subscribeAll: (fn) => ((onStream = fn as never), () => {}),
      subscribeAdded: (fn) => ((onAdded = fn as never), () => {}),
      subscribeRemoved: (fn) => ((onRemoved = fn), () => {})
    })
    const heard: string[] = []
    activity.subscribe(() => heard.push('change'))
    expect(activity.busy()).toBe(true)
    states = ['idle', 'done']
    onStream?.('s1', { kind: 'event', event: { type: 'state_change', state: 'done' } })
    expect(activity.busy()).toBe(false)
    onStream?.('s1', { kind: 'pty', data: new Uint8Array() })
    states = ['idle']
    onRemoved?.('s1')
    states = ['idle', 'working']
    onAdded?.()
    expect(activity.busy()).toBe(true)
    expect(heard).toEqual(['change', 'change', 'change'])
  })
})

describe('the script runner', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const standIn = (body: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'clave-upgrade-runner-'))
    const script = join(dir, 'install-server.sh')
    writeFileSync(script, `#!/bin/bash\n${body}\n`)
    chmodSync(script, 0o755)
    return script
  }

  it('copies the script under the data directory, logs its output and reports its exit', async () => {
    const script = standIn('echo "args: $*"; echo "last words" >&2; exit 3')
    const dataDir = join(dir, 'data')
    const runner = scriptRunner({ dataDir, name: 'e2e', platform: 'darwin' })
    const result = await runner.start({ script, args: ['--name', 'e2e', '--ref', 'v3.0.0'] })
    expect(result.code).toBe(3)
    expect(result.tail).toContain('last words')
    const copy = join(dataDir, 'upgrade', 'install-server.sh')
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(script, 'utf8'))
    expect(statSync(join(dataDir, 'upgrade')).mode & 0o777).toBe(0o700)
    const log = readFileSync(join(dataDir, 'upgrade', 'upgrade.log'), 'utf8')
    expect(log).toContain('args: --name e2e --ref v3.0.0')
    expect(log).toContain('last words')
  })

  it('refuses to start on Linux without systemd-run', async () => {
    const script = standIn('touch "$(dirname "$0")/ran"; exit 0')
    const dataDir = join(dir, 'data')
    const runner = scriptRunner({ dataDir, name: 'e2e', platform: 'linux', systemdRun: () => null })
    await expect(runner.start({ script, args: [] })).rejects.toThrow(/systemd-run/)
    expect(existsSync(join(dataDir, 'upgrade', 'ran'))).toBe(false)
  })
})

describe('the gate over the real session manager (V1-F4)', () => {
  it('a session added already working stops the count, which starts from zero once it stops', async () => {
    const { SessionManager } = await import('../sessions/session-manager')
    const { EchoAdapter } = await import('../sessions/adapters/echo-adapter')
    vi.useFakeTimers()
    const manager = new SessionManager()
    manager.registerAdapter(new EchoAdapter())
    const runs: unknown[] = []
    const upgrade = createSelfUpgrade({
      version: '3.0.0-beta.6',
      facts: FACTS,
      runner: {
        start: (request) => {
          runs.push(request)
          return new Promise<RunResult>(() => {})
        }
      },
      activity: sessionActivity(manager)
    })
    try {
      upgrade.requestUpgrade({ version: '3.0.0-beta.9', when: 'idle' })
      vi.advanceTimersByTime(30_000)
      await manager.create({
        id: 'added-working',
        provider: 'echo',
        adapterId: 'echo',
        transport: 'events',
        cwd: '/tmp',
        windowKey: 'test',
        state: 'working',
        createdAt: Date.now(),
        title: 'added working'
      })
      expect(manager.list()[0].state).toBe('working')
      vi.advanceTimersByTime(10_000)
      manager.setState('added-working', 'done')
      vi.advanceTimersByTime(UPGRADE_IDLE_MS - 1)
      expect(runs).toEqual([])
      vi.advanceTimersByTime(1)
      expect(runs).toHaveLength(1)
    } finally {
      upgrade.close()
      vi.useRealTimers()
    }
  })
})

describe('what a failed upgrade says on the wire (V1-F3)', () => {
  it.each<[string, string, string]>([
    [
      'a repository URL with a password',
      'Could not reach https://test-user:synthetic-saved-repo-secret@invalid.local/clave.git',
      'Could not reach https://***@invalid.local/clave.git'
    ],
    [
      'an ssh URL with a user',
      'git clone ssh://deploy:pw123@host/x.git',
      'git clone ssh://***@host/x.git'
    ],
    ['NAME=value', 'NPM_TOKEN=abc123def and GH_PASSWORD="two words"', 'NPM_TOKEN=***'],
    ['NAME: value', 'api_key: s3cr3t-value', 'api_key: ***'],
    ['a bearer', 'curl -H Bearer abcdef0123456789', 'curl -H Bearer ***'],
    ['an authorization header', 'Authorization: token abc def', 'Authorization: ***'],
    ['a GitHub token', 'token ghp_0123456789abcdefABCDEF0123 refused', 'token *** refused'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0123456789_abcdefXYZ', '***'],
    ['an OpenAI-style key', 'key sk-proj-0123456789abcdefghij', 'key ***'],
    ['a Slack token', 'xoxb-1234567890-abcdefghij', '***'],
    ['an npm token', 'npm_0123456789abcdefghijABCDEFGHIJ', '***']
  ])('redacts %s', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it('keeps commit SHAs and ordinary log lines readable', () => {
    const line =
      'v3.0.0-beta.9 is 4f1c9a2b7e3d5f6a8b9c0d1e2f3a4b5c6d7e8f90 · npm ERR! code ELIFECYCLE · Restarting the server'
    expect(redactSecrets(line)).toBe(line)
  })

  it('redacts the literal secrets it is told, the server token among them', () => {
    expect(redactSecrets('echo 9f2c-literal-token-0001 >> log', ['9f2c-literal-token-0001'])).toBe(
      'echo *** >> log'
    )
    expect(redactSecrets('nothing to see', ['', 'short'])).toBe('nothing to see')
  })

  it('never publishes the server token in a failure', async () => {
    const clock = fakeClock()
    const { runner, runs } = recordingRunner()
    const upgrade = createSelfUpgrade({
      version: '3.0.0-beta.6',
      facts: FACTS,
      runner,
      activity: fakeActivity(),
      clock,
      secrets: () => ['the-server-bearer-token-0123456789']
    })
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[0].end({ code: 1, tail: 'curl answered for the-server-bearer-token-0123456789' })
    await settle()
    expect(upgrade.info().upgrade.error).toBe('curl answered for ***')
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[1].fail(new Error('spawn failed near the-server-bearer-token-0123456789'))
    await settle()
    expect(upgrade.info().upgrade.error).toBe('spawn failed near ***')
  })

  it('redacts a credential the installer environment carries, and keeps the log as written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-upgrade-env-secret-'))
    try {
      const script = join(dir, 'install-server.sh')
      writeFileSync(
        script,
        '#!/bin/bash\nprintf "npm ERR! registry auth failed: %s\\n" "$NPM_TOKEN"\nexit 7\n'
      )
      const runner = scriptRunner({
        dataDir: join(dir, 'data'),
        name: 'e2e',
        platform: 'darwin',
        env: { HOME: dir, PATH: '/usr/bin:/bin', NPM_TOKEN: 'synthetic-secret-canary-r1026' }
      })
      const result = await runner.start({ script, args: [] })
      expect(result.code).toBe(7)
      expect(result.tail).toContain('npm ERR! registry auth failed: ***')
      expect(result.tail).not.toContain('synthetic-secret-canary-r1026')
      // The log itself is private (0600) under the data directory, kept whole.
      const log = join(dir, 'data', 'upgrade', 'upgrade.log')
      expect(readFileSync(log, 'utf8')).toContain('synthetic-secret-canary-r1026')
      expect(statSync(log).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('redacts the saved repository credential the real installer prints when git fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-upgrade-real-installer-'))
    let upgrade: SelfUpgrade | undefined
    try {
      mkdirSync(join(dir, 'bin'))
      const git = join(dir, 'bin', 'git')
      writeFileSync(git, '#!/bin/bash\nexit 1\n')
      chmodSync(git, 0o700)
      mkdirSync(join(dir, '.config', 'e2e'), { recursive: true })
      writeFileSync(
        join(dir, '.config', 'e2e', 'install.env'),
        "CLAVE_HOST=loopback\nCLAVE_REPO='https://test-user:synthetic-saved-repo-secret@invalid.local/clave.git'\n"
      )
      const runner = scriptRunner({
        dataDir: join(dir, 'data'),
        name: 'e2e',
        platform: 'darwin',
        env: {
          HOME: dir,
          USER: 'e2e',
          SHELL: '/bin/sh',
          PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`
        }
      })
      upgrade = createSelfUpgrade({
        version: '3.0.0-beta.6',
        facts: { name: 'e2e', script: resolve('scripts/install-server.sh'), ref: 'v3.0.0-beta.6' },
        runner,
        activity: { busy: () => false, subscribe: () => () => {} }
      })
      const failed = new Promise<void>((done) =>
        upgrade!.subscribe((status) => {
          if (status.state === 'failed') done()
        })
      )
      upgrade.requestUpgrade({ version: '3.0.0-beta.9', when: 'now' })
      await failed
      const error = upgrade.info().upgrade.error ?? ''
      expect(error).toContain('Could not reach https://***@invalid.local/clave.git')
      expect(error).not.toContain('synthetic-saved-repo-secret')
    } finally {
      upgrade?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe('credentials in quoted and structured forms (V2-F1)', () => {
  const secret = 'synthetic-json-config-credential-r1026'
  it.each<[string, string, string]>([
    ['a JSON key', `{"api_key":"${secret}"}`, '{"api_key":***'],
    ['a JSON key with a space', `{"NPM_TOKEN": "${secret}"}`, '{"NPM_TOKEN": ***'],
    ['a single-quoted key', `{'password': '${secret}'}`, "{'password': ***"],
    ['a JSON authorization', `{"authorization":"Basic ${secret}"}`, '{"authorization":***'],
    [
      'a JSON bearer authorization',
      `{"Authorization": "Bearer ${secret}"}`,
      '{"Authorization": ***'
    ],
    ['a YAML key', `api_key: ${secret}`, 'api_key: ***'],
    ['a quoted YAML key', `"api_key": ${secret}`, '"api_key": ***'],
    ['a quoted YAML key and value', `"api_key": "${secret}"`, '"api_key": ***'],
    ['a YAML authorization', `authorization: Basic ${secret}`, 'authorization: ***'],
    ['a JSON value among others', `{"a":1,"secret":"${secret}","b":2}`, '{"a":1,"secret":***'],
    ['a quoted shell assignment', `API_KEY="two ${secret}"`, 'API_KEY=***']
  ])('masks %s, from its value to the end of the line', (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected)
  })

  it('keeps versions, commits, npm codes and permission errors readable', () => {
    const text =
      'npm ERR! code ELIFECYCLE\nVersion 3.0.0-beta.9, commit 4f1c9a2b7e3d5f6a8b9c0d1e2f3a4b5c6d7e8f90\nCould not prepare the upgrade: permission denied'
    expect(redactSecrets(text)).toBe(text)
  })

  it('never answers a JSON credential an installer printed over authenticated HTTP', async () => {
    const { startEmbedded } = await import('@clave/server')
    const { FakeSource } = await import('@clave/server/test-support')
    const dir = mkdtempSync(join(tmpdir(), 'clave-upgrade-json-secret-'))
    let upgrade: SelfUpgrade | undefined
    let server: Awaited<ReturnType<typeof startEmbedded>> | undefined
    try {
      const script = join(dir, 'install-server.sh')
      writeFileSync(script, `#!/bin/bash\nprintf '%s\\n' '{"api_key":"${secret}"}'\nexit 7\n`)
      upgrade = createSelfUpgrade({
        version: '3.0.0-beta.6',
        facts: { name: 'e2e', script, ref: 'v3.0.0-beta.6' },
        runner: scriptRunner({
          dataDir: join(dir, 'data'),
          name: 'e2e',
          platform: 'darwin',
          env: { HOME: dir, PATH: '/usr/bin:/bin' }
        }),
        activity: { busy: () => false, subscribe: () => () => {} }
      })
      server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: upgrade } })
      const failed = new Promise<void>((done) =>
        upgrade!.subscribe((status) => {
          if (status.state === 'failed') done()
        })
      )
      const auth = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
      const asked = await fetch(`${server.url}/server/upgrade`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ version: '3.0.0-beta.9', when: 'now' })
      })
      expect(asked.status).toBe(200)
      await failed
      const text = await (await fetch(`${server.url}/server/info`, { headers: auth })).text()
      expect(text).toContain('failed')
      expect(text).toContain('"api_key\\":***')
      expect(text).not.toContain(secret)
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
    } finally {
      upgrade?.close()
      await server?.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a credential masked to the end of its line (V3-F1)', () => {
  const marker = 'synthetic-private-password-r1026'

  it.each([
    'fatal: unable to access https://github.com/antasphere/clave.git/: Could not resolve host: github.com',
    'remote: Support for password authentication was removed',
    'npm ERR! code EACCES\nnpm ERR! syscall open\nnpm ERR! path /srv/clave/package-lock.json',
    'npm ERR! command failed\nnpm ERR! command sh -c tsc && electron-vite build',
    'systemd-run: Failed to start transient service unit: Access denied',
    'Process: 123 ExecStart=/bin/bash /home/u/.local/share/clave-server/upgrade/install-server.sh --name clave-server --ref v3.0.0-beta.10 (code=exited, status=127)',
    'fatal: Could not read from remote repository. Permission denied (publickey).',
    'HEAD is now at 8dfeb55ea4af35b15f8bb740e89cff4c8952e1ec v3.0.0-beta.10'
  ])('keeps an ordinary installer line exact: %j', (line) => {
    expect(redactSecrets(line)).toBe(line)
  })

  it.each<[string, string, string]>([
    [
      'an escaped quote in a JSON password',
      JSON.stringify({ password: `prefix"${marker}`, code: 'E401' }),
      '{"password":***'
    ],
    [
      'escaped quotes in a JSON Basic authorization',
      JSON.stringify({ authorization: `Basic "${marker}"` }),
      '{"authorization":***'
    ],
    ['a comma inside a bare shell password', `PASSWORD=prefix,${marker}`, 'PASSWORD=***'],
    ['a JSON array credential value', JSON.stringify({ api_key: [marker] }), '{"api_key":***'],
    ['an npm configuration token', `_authToken=${marker}`, '_authToken=***'],
    [
      'only the line that carries it',
      `first line\n{"password":"${marker}","code":"E401"}\nnpm ERR! code E401`,
      'first line\n{"password":***\nnpm ERR! code E401'
    ]
  ])('masks %s, from its value to the end of the line', (_name, input, expected) => {
    const actual = redactSecrets(input)
    expect(actual).not.toContain(marker)
    expect(actual).toBe(expected)
  })

  it('redacts a known literal in its JSON-escaped spelling too', () => {
    const known = `prefix"${marker}`
    const serialized = `config ${JSON.stringify({ note: known })}`
    expect(redactSecrets(serialized, [known])).not.toContain(marker)
    expect(redactSecrets(serialized, [known])).toBe('config {"note":"***"}')
  })

  it.each<[string, Record<string, string>]>([
    ['by its key', {}],
    ['as a known literal in the environment, escaped', { PASSWORD: '' }]
  ])(
    'never answers an escaped JSON password an installer printed over authenticated HTTP, %s',
    async (_how, extraEnv) => {
      const { startEmbedded } = await import('@clave/server')
      const { FakeSource } = await import('@clave/server/test-support')
      const dir = mkdtempSync(join(tmpdir(), 'clave-upgrade-escaped-secret-'))
      let upgrade: SelfUpgrade | undefined
      let server: Awaited<ReturnType<typeof startEmbedded>> | undefined
      try {
        const payload = JSON.stringify({ password: `prefix"${marker}`, code: 'E401' })
        const script = join(dir, 'install-server.sh')
        // The payload holds no single quote, so the shell literal is exact.
        writeFileSync(script, `#!/bin/bash\nprintf '%s\\n' '${payload}'\nexit 7\n`)
        const env: NodeJS.ProcessEnv = { HOME: dir, PATH: '/usr/bin:/bin' }
        if ('PASSWORD' in extraEnv) env.PASSWORD = `prefix"${marker}`
        upgrade = createSelfUpgrade({
          version: '3.0.0-beta.6',
          facts: { name: 'e2e', script, ref: 'v3.0.0-beta.6' },
          runner: scriptRunner({
            dataDir: join(dir, 'data'),
            name: 'e2e',
            platform: 'darwin',
            env
          }),
          activity: { busy: () => false, subscribe: () => () => {} }
        })
        server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: upgrade } })
        const failed = new Promise<void>((done) =>
          upgrade!.subscribe((status) => {
            if (status.state === 'failed') done()
          })
        )
        const auth = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
        const asked = await fetch(`${server.url}/server/upgrade`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ version: '3.0.0-beta.9', when: 'now' })
        })
        expect(asked.status).toBe(200)
        await failed
        const info = (await (
          await fetch(`${server.url}/server/info`, { headers: auth })
        ).json()) as {
          upgrade: { state: string; error: string }
        }
        expect(info.upgrade.state).toBe('failed')
        expect(info.upgrade.error).not.toContain(marker)
        expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
      } finally {
        upgrade?.close()
        await server?.stop()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
