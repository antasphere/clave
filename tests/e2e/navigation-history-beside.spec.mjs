// Pinned to the in-process server, as the two specs whose setup this copies
// (linked-documents.spec.mjs, artefact-several.spec.mjs): an agent tab's own
// tools open the document and the artefact, through the app's MCP endpoint.
/**
 * Back and Forward with a card beside a tab (PRDCT-5155), in the real app.
 *
 * What shows beside a tab shown alone, its document or its artefact, is part
 * of the place: an agent opening one moves the window to a new place, Back
 * hides the card and leaves the tab alone again, Forward shows it again. The
 * agent here is a synthetic one (a launch profile whose command sleeps), so
 * the tab is a real agent tab with its own MCP token, and the document and
 * the artefact arrive through the same tools a real agent calls. An artefact
 * the agent opens AGAIN while it already shows is no move at all: Back from
 * there must still hide it in one step.
 *
 * The walk of the places themselves (tabs, mosaics, Settings, pages, the
 * list, the keys) is navigation-history.spec.mjs.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  mcpEndpoint,
  mcpHttpClient,
  spawnAgentTabIn,
  toolErrored,
  toolPayload,
  until
} from './harness.mjs'

const CLI =
  process.env.SLIDELESS_E2E_CLI || path.resolve('node_modules/@antasphere/slideless/dist/bin.js')
const DIR = userDataDir('navigation-history-beside')
const ROOT = fixturePath('navigation-history-beside-root')
const DECK = `${ROOT}/deck`
const DRAFT = `${ROOT}/draft.md`
const WS = {
  id: 'cccccccc-0000-4000-8000-000000005155',
  name: 'Beside',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
/** Longer than the 300 ms a place takes to settle: the wait before a check that nothing
 *  was recorded. */
const QUIET_MS = 1200
const BACK = '[data-nav="back"]'
const FORWARD = '[data-nav="forward"]'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const snapshot = (win) => win.evaluate(() => window.__claveNavigationForTests?.snapshot() ?? null)

async function snapshotUntil(win, pred, ms = 8000) {
  const started = Date.now()
  let s = await snapshot(win)
  while (!(s && pred(s)) && Date.now() - started < ms) {
    await sleep(100)
    s = await snapshot(win)
  }
  return s
}

const current = (s) => (s && s.index >= 0 ? s.places[s.index] : null)
const trail = (s) =>
  s
    ? s.places.map(
        (p, i) =>
          `${i === s.index ? '>' : ''}${p.tabs.join('+')}:${JSON.stringify(p.beside)}:${p.kind}`
      )
    : null

/** What shows: the tab tiles on screen, and whether the document panel and the artefact
 *  panel are visible. */
function screen(win) {
  return win.evaluate(() => {
    const shown = (el) =>
      !!el &&
      el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
      el.getBoundingClientRect().width > 0
    return {
      tiles: [...document.querySelectorAll('[data-terminal-tile]')]
        .filter((el) => el.getAttribute('aria-hidden') !== 'true' && shown(el))
        .map((el) => el.getAttribute('data-terminal-tile')),
      document: [...document.querySelectorAll('[data-testid="linked-document-panel"]')].some(shown),
      artefact: [...document.querySelectorAll('[data-testid="slideless-artefact"]')].some(shown)
    }
  })
}

async function screenUntil(win, pred, ms = 8000) {
  const started = Date.now()
  let s = await screen(win)
  while (!pred(s) && Date.now() - started < ms) {
    await sleep(100)
    s = await screen(win)
  }
  return s
}

export async function run(t) {
  t.check('the Slideless command line to test with exists', existsSync(CLI), CLI)
  if (!existsSync(CLI)) return
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(DECK, { recursive: true })
  writeFileSync(`${DECK}/index.html`, '<!doctype html><h1 id="t">a deck</h1>')
  writeFileSync(DRAFT, '# A draft\n\nSome words.\n')
  writeFileSync(`${ROOT}/fake-agent.sh`, '#!/bin/sh\nexec sleep 3600\n')
  chmodSync(`${ROOT}/fake-agent.sh`, 0o755)
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    env: { CLAVE_SLIDELESS_CLI: CLI, CLAVE_TEST_SLIDELESS_REGISTRY: '' }
  })
  try {
    const ready = await until(
      async () => {
        const state = await win.evaluate(() => window.electronAPI.artefacts.slidelessState())
        return state.phase === 'ready' ? state : null
      },
      { tries: 120, gapMs: 250 }
    )
    t.check('Slideless is ready', !!ready, ready)
    await win.evaluate(
      async ({ root, ws }) => {
        await window.electronAPI.launchProfileUpsert({
          id: 'beside-fake-claude',
          name: 'Synthetic agent',
          family: 'claude',
          command: [root + '/fake-agent.sh'],
          additionalArgs: []
        })
        await window.electronAPI.launchProfileSetWorkspace(ws, 'claude', 'beside-fake-claude')
      },
      { root: ROOT, ws: WS.id }
    )
    const agent = await spawnAgentTabIn(app, win, DIR)
    t.check('an agent tab with its own token', !!agent?.token, agent)
    if (!agent?.token) return
    const Z = agent.sessionId
    const client = mcpHttpClient(mcpEndpoint(DIR), agent.token)
    await client.init()

    // ── The tab alone ─────────────────────────────────────────────────────
    let s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [Z]))
    t.check(
      'the agent tab alone is a place, with nothing beside it',
      same(current(s)?.tabs, [Z]) && same(current(s)?.beside, { [Z]: null }),
      trail(s)
    )
    const alone = s?.index

    // ── A document beside it ──────────────────────────────────────────────
    const opened = await client.call('clave_open_side_panel', { path: DRAFT })
    t.check('the agent opens a document beside its tab', !toolErrored(opened), opened)
    const doc = toolPayload(opened)
    s = await snapshotUntil(win, (x) => x.index === alone + 1)
    let seen = await screenUntil(win, (x) => x.document)
    t.check(
      'the document beside the tab is a new place',
      s?.index === alone + 1 &&
        same(current(s)?.beside, { [Z]: `document:${doc?.id}` }) &&
        seen.document,
      { trail: trail(s), seen }
    )
    t.equal('listed as a document', current(s)?.kind, 'document')
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === alone)
    seen = await screenUntil(win, (x) => !x.document)
    t.check(
      'Back hides the document: the tab is alone again',
      s?.index === alone && !seen.document && !seen.artefact && same(seen.tiles, [Z]),
      { trail: trail(s), seen }
    )
    await win.click(FORWARD)
    s = await snapshotUntil(win, (x) => x.index === alone + 1)
    seen = await screenUntil(win, (x) => x.document)
    t.check(
      'Forward shows it again',
      s?.index === alone + 1 && seen.document && same(seen.tiles, [Z]),
      { trail: trail(s), seen }
    )
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.check(
      'and the restore records no place of its own',
      s?.places.length === alone + 2 && s.index === alone + 1,
      trail(s)
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === alone)
    seen = await screenUntil(win, (x) => !x.document)
    t.check('Back once more: alone', s?.index === alone && !seen.document, {
      trail: trail(s),
      seen
    })

    // ── An artefact beside it ─────────────────────────────────────────────
    const deck = await client.call('clave_open_artefact', { path: DECK })
    t.check('the agent opens an artefact beside its tab', !toolErrored(deck), deck)
    s = await snapshotUntil(
      win,
      (x) => x.index === alone + 1 && String(current(x)?.beside?.[Z]).startsWith('artefact:')
    )
    seen = await screenUntil(win, (x) => x.artefact, 20_000)
    t.check(
      'the artefact beside the tab is a new place, the document’s ahead of it dropped',
      s?.index === alone + 1 &&
        s.places.length === alone + 2 &&
        same(current(s)?.beside, { [Z]: `artefact:${DECK}` }) &&
        seen.artefact,
      { trail: trail(s), seen }
    )
    t.equal('listed as an artefact', current(s)?.kind, 'artefact')

    // Opened again while it shows: the same place, so Back is still one step.
    const again = await client.call('clave_open_artefact', { path: DECK })
    t.check('the agent opens the same artefact again', !toolErrored(again), again)
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.check(
      'an artefact opened again while it shows is no new place',
      s?.places.length === alone + 2 && s.index === alone + 1,
      trail(s)
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === alone)
    seen = await screenUntil(win, (x) => !x.artefact)
    t.check(
      'Back hides the artefact in one step: the tab is alone again',
      s?.index === alone && !seen.artefact && !seen.document && same(seen.tiles, [Z]),
      { trail: trail(s), seen }
    )
    await win.click(FORWARD)
    s = await snapshotUntil(win, (x) => x.index === alone + 1)
    seen = await screenUntil(win, (x) => x.artefact, 20_000)
    t.check(
      'Forward shows the artefact again',
      s?.index === alone + 1 && seen.artefact && same(seen.tiles, [Z]),
      { trail: trail(s), seen }
    )
    await sleep(QUIET_MS)
    s = await snapshot(win)
    t.check(
      'and the restore records no place of its own',
      s?.places.length === alone + 2 && s.index === alone + 1,
      trail(s)
    )
  } finally {
    await app.close()
  }
}
