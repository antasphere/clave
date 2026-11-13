import { Effect, Layer } from 'effect'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { expect, it } from 'vitest'
import { startEmbedded } from '../embedded'
import { createApiClient } from '../../../client/src/api'
import { FakeSource } from '../test-support'
import { ServerInfoPort } from './port'
import { serverInfoHandlers } from './handlers'
import { serverUpgradeFixtureCatalog } from './server-info.fixtures'
import {
  UPGRADE_IDLE_MS,
  createSelfUpgrade,
  type RunResult,
  type UpgradeRunner
} from '../../../../src/main/server/self-upgrade'

it('loads server-upgrade/requested-when-idle through the command, with a recording runner, and verifies it over HTTP', async () => {
  // A clock moved by hand, and a runner that records and installs nothing.
  let now = 10_000
  const timers: Array<{ at: number; fn: () => void }> = []
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn }
      timers.push(timer)
      return timer
    },
    clearTimeout: (handle: unknown) => {
      const i = timers.indexOf(handle as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    }
  }
  const advance = (ms: number): void => {
    now += ms
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.fn()
    }
  }
  const runs: Array<{ script: string; args: string[] }> = []
  const runner: UpgradeRunner = {
    start: (request) => {
      runs.push(request)
      return new Promise<RunResult>(() => {})
    }
  }
  const upgrade = createSelfUpgrade({
    version: '3.0.0-beta.6',
    facts: {
      name: 'fixture-server',
      script: '/srv/clave/current/scripts/install-server.sh',
      ref: 'v3.0.0-beta.6'
    },
    runner,
    activity: { busy: () => false, subscribe: () => () => {} },
    clock
  })
  const server = await startEmbedded({ ports: { sessions: new FakeSource(), serverInfo: upgrade } })
  const api = createApiClient({ url: server.url, token: server.token })
  try {
    const fixtures = await Effect.runPromise(
      serverUpgradeFixtureCatalog.prepare('server-upgrade/requested-when-idle', {
        version: '3.0.0-beta.9'
      })
    )
    const layer = buses.pipe(
      Layer.provide(HandlerRegistry.layer(...serverInfoHandlers)),
      Layer.provide(ServerInfoPort.layer(upgrade))
    )
    const report = await Effect.runPromise(
      (
        run({ fixtures, enabled: true, ready: () => Effect.void }) as Effect.Effect<
          RunReport<Readonly<Record<string, unknown>>>,
          FixtureError,
          CommandBus
        >
      ).pipe(Effect.provide(layer))
    )
    expect(report.completed).toEqual(['server-upgrade/request'])
    expect(report.values.upgrade).toMatchObject({
      state: 'waiting-for-idle',
      target: '3.0.0-beta.9'
    })
    // Read back through GetServerInfo, the way a Mac reads it.
    expect((await api.server.info()).upgrade).toEqual({
      supported: true,
      state: 'waiting-for-idle',
      target: '3.0.0-beta.9',
      mode: 'when-idle',
      since: 10_000
    })
    advance(UPGRADE_IDLE_MS - 1)
    expect(runs).toEqual([])
    advance(1)
    expect(runs).toEqual([
      {
        script: '/srv/clave/current/scripts/install-server.sh',
        args: ['--name', 'fixture-server', '--ref', 'v3.0.0-beta.9']
      }
    ])
    expect((await api.server.info()).upgrade).toMatchObject({
      state: 'running',
      target: '3.0.0-beta.9'
    })
    console.log(
      JSON.stringify({
        scenario: 'server-upgrade/requested-when-idle',
        runId: report.runId,
        completed: report.completed,
        runs
      })
    )
  } finally {
    upgrade.close()
    await api.dispose()
    await server.stop()
  }
}, 15_000)
