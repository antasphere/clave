// A window's own workspace write never echoes back to it, and reaches every
// other window once (lane D of wave 2, PRDCT-3242). Two windows on the
// in-process server, both on the push channel: window A writes its pins and
// hears nothing; window B hears the change exactly once. This pins the
// preload's use of the echo drop (`workspaceStatePick` in
// `src/preload/dual-listener.ts`) at the wiring, which the unit test cannot
// see: round 3's verifier replaced the preload's call with an inline pick
// and every gate stayed green.
//
// The renderer writes back on a fold: when a window folds another window's
// change, its persist pass writes the partitions the fold did not carry, and
// the other window folds that and writes back in turn, until the two agree
// (measured: one write from the spec lands as three in main). That is the
// renderer's own behaviour, the same over IPC on dev, so the deliveries are
// counted against the writes that landed in main, by origin: every window
// hears exactly the writes that are not its own, and none of its own.
//
// Pinned to the in-process server (`server: 'in-process'`): the workspace
// writes of an attached window land on the standalone server, which is
// another process with no second window of this app on it.
import { mkdirSync, rmSync } from 'node:fs'
import {
  launchApp,
  openWindow,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'

const DIR = userDataDir('settings-echo')
const ROOT = fixturePath('settings-echo-root')
const WS = { id: 'echo-ws', name: 'Echo', rootDir: ROOT, profileFile: null, createdAt: 1 }

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win: a } = await launchApp(DIR, { server: 'in-process' })
  try {
    const { page: b } = await openWindow(app, a, WS.id)
    const listen = (page) =>
      page.evaluate(() => {
        window.__echoSeen = 0
        window.__echoOff = window.electronAPI.onWorkspaceStateChanged(() => {
          window.__echoSeen += 1
        })
      })
    await listen(a)
    await listen(b)
    // Every write that lands in main, with its origin: the renderer must not
    // write anything back on a fold, or a count of deliveries would measure
    // its write-backs rather than the transport.
    await app.evaluate(() => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source: is --test-no-activate on?')
      globalThis.__echoWrites = []
      const updatePins = settings.workspaces.updatePins
      settings.workspaces.updatePins = (scope, pins, origin) => {
        globalThis.__echoWrites.push({ scope, origin: origin ?? null })
        return updatePins(scope, pins, origin)
      }
    })
    // Both listeners are on the push channel before the write: a routed call
    // that answers proves the backing, and the status swap follows the
    // welcome, which the first routed call of each window already awaited.
    await a.evaluate(() => window.electronAPI.workspaceLoad())
    await b.evaluate(() => window.electronAPI.workspaceLoad())
    await a.waitForTimeout(500)

    const keyOf = (page) =>
      page.evaluate(() => window.electronAPI.windowIdentity().then((i) => i?.windowKey))
    const keyA = await keyOf(a)
    const keyB = await keyOf(b)
    t.check(
      'the two windows have distinct keys',
      typeof keyA === 'string' && typeof keyB === 'string' && keyA !== keyB
    )
    const settled = async () => {
      // The write-backs converge: wait until the write count holds still.
      let last = -1
      await until(
        async () => {
          const n = (await app.evaluate(() => globalThis.__echoWrites)).length
          const still = n === last
          last = n
          return still
        },
        { tries: 30, gapMs: 400 }
      )
      await a.waitForTimeout(600)
      return app.evaluate(() => globalThis.__echoWrites)
    }
    const expected = (writes, key) => writes.filter((w) => w.origin !== key).length

    const result = await a.evaluate((ws) => window.electronAPI.workspaceUpdatePins(ws, []), WS.id)
    t.check('window A wrote its pins', result?.ok === true)
    const writes1 = await settled()
    t.check('the write landed in main with A as its origin', writes1[0]?.origin === keyA)
    t.equal(
      'window B heard every write that was not its own, once each',
      await b.evaluate(() => window.__echoSeen),
      expected(writes1, keyB)
    )
    t.equal(
      'window A heard every write that was not its own, and none of its own',
      await a.evaluate(() => window.__echoSeen),
      expected(writes1, keyA)
    )

    const second = await b.evaluate((ws) => window.electronAPI.workspaceUpdatePins(ws, []), WS.id)
    t.check('window B wrote its pins', second?.ok === true)
    const writes2 = await settled()
    t.check('B’s write landed with B as its origin', writes2[writes1.length]?.origin === keyB)
    t.equal(
      'window A heard every write that was not its own, once each',
      await a.evaluate(() => window.__echoSeen),
      expected(writes2, keyA)
    )
    t.equal(
      'window B heard every write that was not its own, and none of its own',
      await b.evaluate(() => window.__echoSeen),
      expected(writes2, keyB)
    )
    await a.evaluate(() => window.__echoOff())
    await b.evaluate(() => window.__echoOff())
  } finally {
    await app.close()
  }
}
