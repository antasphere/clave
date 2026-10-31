import fs from 'node:fs'
import { Effect } from 'effect'
import { expect, it } from 'vitest'
import { fixtureDataDir } from './antasphere-account.fixtures'
import {
  MobileFixturesLive,
  loadMobileScenario,
  cleanupMobileFixtures
} from './mobile-pairing.fixtures'

it('loads and verifies the paired-phone scenario with an isolated owner and cleans only its run', async () => {
  const report = await Effect.runPromise(
    loadMobileScenario().pipe(Effect.provide(MobileFixturesLive))
  )
  console.log(
    JSON.stringify({
      scenario: 'mobile/paired-phone',
      runId: report.runId,
      completed: report.completed,
      ids: report.ids
    })
  )
  expect(report.completed).toEqual(['mobile/issuer', 'mobile/owner', 'mobile/phone'])
  const phone = report.values.phone as { deviceId: string }
  const dataDir = fixtureDataDir(report.runId)
  expect(JSON.parse(fs.readFileSync(`${dataDir}/devices.json`, 'utf8')).devices[0].id).toBe(
    phone.deviceId
  )
  await Effect.runPromise(
    cleanupMobileFixtures(report.runId).pipe(Effect.provide(MobileFixturesLive))
  )
  expect(fs.existsSync(dataDir)).toBe(false)
}, 60_000)
