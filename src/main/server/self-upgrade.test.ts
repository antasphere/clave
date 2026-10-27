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
  readInstallFacts,
  readRunStatus,
  runFailure,
  scriptRunner,
  serverVersion,
  sessionActivity,
  upgradeArgs,
  upgradeIdleMs,
  upgradeLaunch,
  UpgradeLaunchFailure,
  type AgentActivity,
  type Clock,
  type RunResult,
  type ScriptRunnerOptions,
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

/** install-server.sh's own prologue (info, warn, fail, phase and the status
 *  file the last two write), as the first lines of a stand-in script. */
function scriptPrologue(): string {
  const source = readFileSync(resolve('scripts/install-server.sh'), 'utf8')
  const start = source.indexOf("RED='")
  const end = source.indexOf('usage() {')
  expect(start, 'the message functions').toBeGreaterThan(0)
  expect(end, 'the end of the message functions').toBeGreaterThan(start)
  return source.slice(start, end)
}

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
      status: '/data/upgrade/install-status',
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
        '--setenv=CLAVE_INSTALL_STATUS_FILE=/data/upgrade/install-status',
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
      env: {},
      detached: false
    })
  })

  it('fails clearly on Linux without systemd-run, running nothing', () => {
    expect(
      upgradeLaunch('linux', {
        name: 'clave-server',
        copy: '/c',
        log: '/l',
        status: '/s',
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
        status: '/data/upgrade/install-status',
        args: upgradeArgs('clave-server', '3.0.0'),
        path: '/usr/bin',
        home: '/Users/u',
        epoch: 1,
        systemdRun: null
      })
    ).toEqual({
      command: '/bin/bash',
      args: ['/data/upgrade/install-server.sh', '--name', 'clave-server', '--ref', 'v3.0.0'],
      env: { CLAVE_INSTALL_STATUS_FILE: '/data/upgrade/install-status' },
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

  it('reports a failed run with its failure, and keeps serving', async () => {
    const { upgrade, runs } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    const failure = {
      code: 'build-incomplete',
      phase: 'build',
      exitCode: 1,
      logPath: '/l'
    } as const
    runs[0].end({ code: 1, failure })
    await settle()
    expect(upgrade.info().upgrade).toEqual({
      supported: true,
      state: 'failed',
      target: '3.0.0',
      mode: 'now',
      failure,
      since: 1_000
    })
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    expect(runs).toHaveLength(2)
  })

  it('reports a run that could not start with its code, never the error text', async () => {
    const { upgrade, runs } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[0].fail(
      new UpgradeLaunchFailure(
        { code: 'launcher-missing', logPath: '/l' },
        'systemd-run is not available on this server'
      )
    )
    await settle()
    expect(upgrade.info().upgrade).toMatchObject({
      state: 'failed',
      failure: { code: 'launcher-missing', logPath: '/l' }
    })
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[1].fail(new Error('spawn failed near the-server-bearer-token-0123456789'))
    await settle()
    expect(upgrade.info().upgrade.failure).toEqual({ code: 'launch-failed' })
    expect(JSON.stringify(upgrade.info())).not.toContain('bearer-token')
  })

  it('goes back to idle when the script exits 0 with the server still up', async () => {
    const { upgrade, runs } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'now' })
    runs[0].end({ code: 0, failure: { code: 'unknown', exitCode: 0 } })
    await settle()
    expect(upgrade.info().upgrade).toEqual({ supported: true, state: 'idle', since: 1_000 })
  })

  it('tells its subscribers every change', async () => {
    const { upgrade, runs, clock, statuses } = world()
    upgrade.requestUpgrade({ version: '3.0.0', when: 'idle' })
    clock.advance(UPGRADE_IDLE_MS)
    runs[0].end({ code: 2, failure: { code: 'unknown', exitCode: 2 } })
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
    // No code in its status file: `unknown`, its exit and where the log is.
    expect(result.failure).toEqual({
      code: 'unknown',
      exitCode: 3,
      logPath: join(dataDir, 'upgrade', 'upgrade.log')
    })
    const copy = join(dataDir, 'upgrade', 'install-server.sh')
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(script, 'utf8'))
    expect(statSync(join(dataDir, 'upgrade')).mode & 0o777).toBe(0o700)
    const log = readFileSync(join(dataDir, 'upgrade', 'upgrade.log'), 'utf8')
    expect(log).toContain('args: --name e2e --ref v3.0.0')
    expect(log).toContain('last words')
  })

  it('gives the script a status file of its own, private and emptied for each run', async () => {
    const script = standIn(
      [
        'here="$(dirname "$0")"',
        'printf "%s\\n" "$CLAVE_INSTALL_STATUS_FILE" > "$here/told"',
        '[ -e "$here/once" ] && exit 2',
        'touch "$here/once"',
        'printf "phase=clone\\ncode=no-such-release\\n" >> "$CLAVE_INSTALL_STATUS_FILE"',
        'exit 1'
      ].join('\n')
    )
    const dataDir = join(dir, 'data')
    const upgradeDir = join(dataDir, 'upgrade')
    const log = join(upgradeDir, 'upgrade.log')
    const runner = scriptRunner({
      dataDir,
      name: 'e2e',
      platform: 'darwin',
      env: { HOME: dir, PATH: '/usr/bin:/bin' }
    })
    expect((await runner.start({ script, args: [] })).failure).toEqual({
      code: 'no-such-release',
      phase: 'clone',
      exitCode: 1,
      logPath: log
    })
    const status = join(upgradeDir, 'install-status')
    expect(readFileSync(join(upgradeDir, 'told'), 'utf8')).toBe(`${status}\n`)
    expect(statSync(status).mode & 0o777).toBe(0o600)
    expect((await runner.start({ script, args: [] })).failure).toEqual({
      code: 'unknown',
      exitCode: 2,
      logPath: log
    })
  })

  it('refuses to start on Linux without systemd-run', async () => {
    const script = standIn('touch "$(dirname "$0")/ran"; exit 0')
    const dataDir = join(dir, 'data')
    const runner = scriptRunner({ dataDir, name: 'e2e', platform: 'linux', systemdRun: () => null })
    const refused = await runner.start({ script, args: [] }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(UpgradeLaunchFailure)
    expect((refused as UpgradeLaunchFailure).failure).toEqual({
      code: 'launcher-missing',
      logPath: join(dataDir, 'upgrade', 'upgrade.log')
    })
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

describe('what a run tells of its failure: codes and phases from closed lists (V6)', () => {
  it('keeps the last known code and the last known phase, and nothing else', () => {
    expect(
      readRunStatus(
        [
          'code=no-such-release',
          'phase=resolve',
          'Could not reach https://user:synthetic-secret-r1026@invalid.local/clave.git',
          'code=repository-unreachable',
          'phase=clone',
          'code=no-such-thing',
          'phase=compile',
          'code=Rolled-Back',
          'code=rolled-back trailing',
          ' code=rolled-back',
          'code=rolled-back\r',
          'code==rolled-back',
          'phase=build=x',
          'npm ERR! token=synthetic-secret-r1026',
          ''
        ].join('\n')
      )
    ).toEqual({ code: 'repository-unreachable', phase: 'clone' })
  })

  it('reads nothing from no file, an empty one, or one with no known line', () => {
    expect(readRunStatus(null)).toEqual({})
    expect(readRunStatus('')).toEqual({})
    expect(readRunStatus('child wrote here\ncode=\nphase=\n')).toEqual({})
  })

  it('names a failure unknown when the script wrote no code, with its exit and log', () => {
    expect(runFailure('phase=dependencies\nnpm ERR!\n', 1, '/l')).toEqual({
      code: 'unknown',
      phase: 'dependencies',
      exitCode: 1,
      logPath: '/l'
    })
    expect(runFailure(null, 7, '/l')).toEqual({ code: 'unknown', exitCode: 7, logPath: '/l' })
  })
})

// Each case starts a real server and runs the real install script: room on a
// loaded machine, as main's version sync wiring tests have.
const OVER_HTTP =
  'no text from the run leaves the server, over authenticated HTTP (V6-F1, V6-F2, V6-F3)'
describe(OVER_HTTP, { timeout: 15_000 }, () => {
  const marker = 'synthetic-published-private-value-r1026'
  const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

  interface Fixture {
    /** A stand-in script's body, written to `<dir>/install-server.sh`. */
    body?: string
    /** Or the script to run, as is. */
    script?: string
    env?: NodeJS.ProcessEnv
    runner?: Partial<ScriptRunnerOptions>
  }
  interface Outcome {
    /** `/server/info` as the wire carried it, raw. */
    wire: string
    upgrade: ServerUpgradeStatus
    /** What the status file held once the run ended. */
    status: string | null
    logged: string
    log: string
  }
  const KEYS = ['failure', 'mode', 'since', 'state', 'supported', 'target']
  const FAILURE_KEYS = ['code', 'exitCode', 'logPath', 'phase']

  async function failOver(make: Fixture | ((dir: string) => Fixture)): Promise<Outcome> {
    const { startEmbedded } = await import('@clave/server')
    const { FakeSource } = await import('@clave/server/test-support')
    const dir = mkdtempSync(join(tmpdir(), 'clave-upgrade-codes-'))
    let upgrade: SelfUpgrade | undefined
    let server: Awaited<ReturnType<typeof startEmbedded>> | undefined
    try {
      const fixture = typeof make === 'function' ? make(dir) : make
      let script = fixture.script
      if (!script) {
        script = join(dir, 'install-server.sh')
        writeFileSync(script, `#!/bin/bash\n${fixture.body ?? ''}\n`)
      }
      const log = join(dir, 'data', 'upgrade', 'upgrade.log')
      upgrade = createSelfUpgrade({
        version: '3.0.0-beta.6',
        facts: { name: 'e2e', script, ref: 'v3.0.0-beta.6' },
        runner: scriptRunner({
          dataDir: join(dir, 'data'),
          name: 'e2e',
          platform: 'darwin',
          env: { HOME: dir, USER: 'e2e', SHELL: '/bin/sh', PATH: '/usr/bin:/bin', ...fixture.env },
          ...fixture.runner
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
      const wire = await (await fetch(`${server.url}/server/info`, { headers: auth })).text()
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
      const read = (file: string): string | null =>
        existsSync(file) ? readFileSync(file, 'utf8') : null
      const { upgrade: status } = JSON.parse(wire) as { upgrade: ServerUpgradeStatus }
      // Whatever the run did, the wire carries these keys and no other.
      for (const key of Object.keys(status)) expect(KEYS).toContain(key)
      for (const key of Object.keys(status.failure ?? {})) expect(FAILURE_KEYS).toContain(key)
      return {
        wire,
        upgrade: status,
        status: read(join(dir, 'data', 'upgrade', 'install-status')),
        logged: read(log) ?? '',
        log
      }
    } finally {
      upgrade?.close()
      await server?.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  /** A stand-in that speaks through install-server.sh's own prologue. */
  const speaking = (body: string, env: NodeJS.ProcessEnv = {}): Fixture => ({
    body: `${scriptPrologue()}\n${body}`,
    env
  })
  /** The real install-server.sh, with a `git` of the test's own and a saved repository. */
  const realInstaller =
    (git: string, repo?: string, env: NodeJS.ProcessEnv = {}) =>
    (dir: string): Fixture => {
      mkdirSync(join(dir, 'bin'))
      writeFileSync(join(dir, 'bin', 'git'), `#!/bin/bash\n${git}\n`)
      chmodSync(join(dir, 'bin', 'git'), 0o700)
      mkdirSync(join(dir, '.config', 'e2e'), { recursive: true })
      writeFileSync(
        join(dir, '.config', 'e2e', 'install.env'),
        `CLAVE_HOST=loopback\n${repo ? `CLAVE_REPO=${shellQuote(repo)}\n` : ''}`
      )
      return {
        script: resolve('scripts/install-server.sh'),
        env: {
          PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
          ...env
        }
      }
    }

  it("publishes the script's code and phase, its exit and the log's path, and none of its message", async () => {
    const out = await failOver(
      speaking(
        `phase build\nfail build-incomplete ${shellQuote(`The build did not produce ${marker}`)}`
      )
    )
    expect(out.upgrade.failure).toEqual({
      code: 'build-incomplete',
      phase: 'build',
      exitCode: 1,
      logPath: out.log
    })
    expect(out.wire).not.toContain(marker)
    expect(out.logged).toContain(marker)
  })

  it('keeps only the known code of what a stand-in appends to its own status file', async () => {
    const out = await failOver(
      speaking(
        [
          'phase dependencies',
          `printf '%s\\n' ${shellQuote(`npm ERR! ${marker}`)} 'code=no-such-thing' 'code=release-too-old' ${shellQuote(`code=${marker}`)} 'phase=Build' 'phase=clone' ${shellQuote(`Could not reach https://u:${marker}@invalid.local/x.git`)} >> "$STATUS_FILE"`,
          'exit 7'
        ].join('\n')
      )
    )
    expect(out.status).toContain(marker)
    expect(out.upgrade.failure).toEqual({
      code: 'release-too-old',
      phase: 'clone',
      exitCode: 7,
      logPath: out.log
    })
    expect(out.wire).not.toContain(marker)
  })

  // The verifier's three routes from a child of the real installer to its
  // status file. Each child writes text and a code of its own; the script's
  // own code comes after it, and only codes ever leave.
  const childWrites = (find: string): string =>
    [
      'case " $* " in *" ls-remote "*) ;; *) exit 1 ;; esac',
      `file="$(${find})"`,
      '[[ -n "$file" ]] || exit 1',
      `printf '%s\\n' ${shellQuote(`child-only ${marker}`)} ${shellQuote(`code=${marker}`)} >> "$file"`,
      'exit 1'
    ].join('\n')
  it.each<[string, string]>([
    [
      // macOS has no /proc: the child is handed the path the /proc read recovers on Linux.
      'the /proc environ route',
      `if [[ -r /proc/$PPID/environ ]]; then tr '\\0' '\\n' < /proc/$PPID/environ | sed -n 's/^CLAVE_INSTALL_STATUS_FILE=//p'; else printf '%s' "$RECOVERED"; fi`
    ],
    [
      'the inherited stderr route',
      `lsof -a -p $$ -d 2 -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 | sed 's#upgrade.log$#install-status#'`
    ],
    [
      "the parent's command line route",
      `ps -o args= -p $PPID | awk '{ print $2 }' | sed 's#install-server.sh$#install-status#'`
    ]
  ])('publishes only codes when a child reaches the status file by %s', async (_route, find) => {
    const out = await failOver((dir) =>
      realInstaller(childWrites(find), undefined, {
        RECOVERED: join(dir, 'data', 'upgrade', 'install-status')
      })(dir)
    )
    expect(out.status, 'the child did reach the file').toContain(`child-only ${marker}`)
    expect(out.upgrade.failure).toEqual({
      code: 'repository-unreachable',
      phase: 'resolve',
      exitCode: 1,
      logPath: out.log
    })
    expect(out.wire).not.toContain(marker)
  })

  it.each<[string, string, NodeJS.ProcessEnv]>([
    [
      'a URL whose delimiter a known value covers (V6-F2)',
      `https://gituser:${marker}@invalid.local/clave.git`,
      { OTHER_PASSWORD: '@invalid.local' }
    ],
    [
      'a URL whose password holds a newline (V6-F3)',
      `https://gituser:synthetic-publishe\nd-private-value-r1026@invalid.local/clave.git`,
      {}
    ]
  ])('publishes no URL at all for %s', async (_name, repo, env) => {
    const out = await failOver(realInstaller('exit 1', repo, env))
    expect(out.upgrade.failure).toEqual({
      code: 'repository-unreachable',
      phase: 'resolve',
      exitCode: 1,
      logPath: out.log
    })
    expect(out.wire).not.toContain('://')
    expect(out.wire).not.toContain('invalid.local')
    expect(out.wire).not.toMatch(/synthetic-publishe/)
  })

  it('reads nothing from a status file larger than 64 KiB, whatever it ends with', async () => {
    const out = await failOver(
      speaking(
        `for i in $(seq 1 3000); do printf 'padding line %s of a run that wrote far too much\\n' "$i" >> "$STATUS_FILE"; done\nphase build\nfail build-incomplete x`
      )
    )
    expect(out.status?.length).toBeGreaterThan(64 * 1024)
    expect(out.upgrade.failure).toEqual({ code: 'unknown', exitCode: 1, logPath: out.log })
  })

  it('names a missing systemd-run, and nothing else', async () => {
    const out = await failOver({
      body: 'exit 7',
      runner: { platform: 'linux', systemdRun: () => null }
    })
    expect(out.upgrade.failure).toEqual({ code: 'launcher-missing', logPath: out.log })
    expect(out.logged).toContain('systemd-run is not available')
  })

  it('names a run it could not prepare, never the path that failed nor a log it never wrote', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const out = await failOver((dir) => ({
        script: join(dir, marker, 'absent.sh'),
        env: { NPM_TOKEN: marker }
      }))
      expect(out.upgrade.failure).toEqual({ code: 'launch-failed' })
      expect(out.wire).not.toContain(marker)
      expect(String(said.mock.calls[0]?.[0])).toContain('Could not prepare the upgrade')
    } finally {
      said.mockRestore()
    }
  })
})
