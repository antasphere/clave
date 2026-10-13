// One change to the pins lands as one write (wave 5, lane A, PRDCT-3264).
// A window that takes in another window's change used to write the folded
// partition back: the fold set the store before it recorded the folded
// content as persisted, so the persistence subscriber found the partition
// changed and wrote it over with this window's origin, and the other window
// did the same with that write, until the two agreed. Measured by the
// verifier of lane D of wave 2: a non-empty partition written once landed
// as three writes in main. The fold records first and sets after; the count
// is the proof.
//
// Two windows on the same server, both on the push channel; the writes that
// land in the settings source are counted by origin, as settings-echo does,
// and the write enters through the preload (the renderer's own path to the
// source), so what is counted is the fold's behaviour in the other window
// and nothing of the writer's store. Both modes.
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

const DIR = userDataDir('workspace-pins-one-write')
const ROOT = fixturePath('workspace-pins-one-write-root')
const WS = { id: 'one-write-ws', name: 'One write', rootDir: ROOT, profileFile: null, createdAt: 1 }
const PIN = {
  id: 'pin-folded',
  name: 'Folded pin',
  cwd: ROOT,
  color: 'teal',
  prompt: null,
  sessions: [],
  terminals: [],
  createdAt: 1,
  filePath: null,
  rootDir: null,
  workspaceRoot: null,
  toolbar: false,
  logo: null,
  category: null,
  discoveredBy: null,
  workspaceId: WS.id
}

/** The names on the group picker's cards, opened and closed again. */
async function pickerNames(win) {
  await win.click('button[aria-label="Add a group"]')
  await win.waitForTimeout(400)
  const names = await win.evaluate(() =>
    [...document.querySelectorAll('.group-picker-card')].map((c) => c.getAttribute('title'))
  )
  await win.keyboard.press('Escape')
  await win.waitForTimeout(200)
  return names.sort()
}

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win: a, fixture } = await launchApp(DIR)
  try {
    const { page: b } = await openWindow(app, a, WS.id)
    const listen = (page) =>
      page.evaluate(() => {
        window.__foldSeen = 0
        window.__foldOff = window.electronAPI.onWorkspaceStateChanged(() => {
          window.__foldSeen += 1
        })
      })
    await listen(a)
    await listen(b)
    // Both windows on the push channel: a routed call proves the backing,
    // and the welcome follows it.
    await a.evaluate(() => window.electronAPI.workspaceLoad())
    await b.evaluate(() => window.electronAPI.workspaceLoad())
    await a.waitForTimeout(500)
    await fixture.evaluate(() => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source: is --test-no-activate on?')
      globalThis.__landed = []
      const updatePins = settings.workspaces.updatePins
      settings.workspaces.updatePins = (scope, pins, origin) => {
        globalThis.__landed.push({ scope, origin: origin ?? null, at: Date.now() })
        return updatePins(scope, pins, origin)
      }
    })
    const keyOf = (page) =>
      page.evaluate(() => window.electronAPI.windowIdentity().then((i) => i?.windowKey))
    const keyA = await keyOf(a)
    const keyB = await keyOf(b)
    t.check(
      'the two windows have distinct keys',
      typeof keyA === 'string' && typeof keyB === 'string' && keyA !== keyB
    )

    const result = await a.evaluate(
      ({ ws, pin }) => window.electronAPI.workspaceUpdatePins(ws, [pin]),
      { ws: WS.id, pin: PIN }
    )
    t.check('window A wrote a non-empty partition', result?.ok === true, result)
    t.check(
      'the write answered the state’s stamp',
      typeof result?.revision === 'number' && typeof result?.instance === 'string',
      result
    )
    // Give a write-back every chance to land before counting: the old order
    // wrote back within 40 ms; wait well past that and until the count holds.
    let last = -1
    const still = await until(
      async () => {
        const n = (await fixture.evaluate(() => globalThis.__landed)).length
        const same = n === last
        last = n
        return same
      },
      { tries: 20, gapMs: 400 }
    )
    t.check('the writes settled', still === true, last)
    await a.waitForTimeout(1500)
    const landed = await fixture.evaluate(() => globalThis.__landed)
    t.equal('one write landed in the settings source, and no write-back', landed.length, 1)
    t.check('the one write is window A’s', landed[0]?.origin === keyA, landed)
    t.equal('window B heard the change once', await b.evaluate(() => window.__foldSeen), 1)
    t.equal('window A heard nothing of its own write', await a.evaluate(() => window.__foldSeen), 0)
    t.equal('window B shows the folded pin', await pickerNames(b), ['Folded pin'])

    await a.evaluate(() => window.__foldOff())
    await b.evaluate(() => window.__foldOff())
  } finally {
    await app.close()
  }
}
