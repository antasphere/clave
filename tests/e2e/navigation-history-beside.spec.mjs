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
 * there must still hide it in one step. A card the agent opens while the
 * person is on another tab has not been seen: Back to its tab shows it rather
 * than hiding it or putting back the deck it replaced, a later click on the
 * tab's row still shows it, and one the person watched open still steps.
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
  callMcp,
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
/** Decks the agent opens later; each is named on screen by its folder (the frame's title). */
const SECOND = `${ROOT}/second`
const THIRD = `${ROOT}/third`
const FOURTH = `${ROOT}/fourth`
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
const rowOf = (id) => `[data-sidebar-item-id="${id}"] button.sidebar-item`

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

/** What shows: the tab tiles on screen, whether the document panel and the artefact panel
 *  are visible, and which artefact the visible panel frames (its title: the deck's folder). */
function screen(win) {
  return win.evaluate(() => {
    const shown = (el) =>
      !!el &&
      el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
      el.getBoundingClientRect().width > 0
    const frames = [...document.querySelectorAll('[data-testid="slideless-artefact"]')]
    return {
      tiles: [...document.querySelectorAll('[data-terminal-tile]')]
        .filter((el) => el.getAttribute('aria-hidden') !== 'true' && shown(el))
        .map((el) => el.getAttribute('data-terminal-tile')),
      document: [...document.querySelectorAll('[data-testid="linked-document-panel"]')].some(shown),
      artefact: frames.some(shown),
      artefactTitle: frames.find(shown)?.getAttribute('title') ?? null
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
  for (const deck of [DECK, SECOND, THIRD, FOURTH]) {
    mkdirSync(deck, { recursive: true })
    writeFileSync(`${deck}/index.html`, `<!doctype html><h1 id="t">${path.basename(deck)}</h1>`)
  }
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

    // ── A deck the agent opens while the person is on another tab ─────────
    // A card is seen once a recorded place has shown it. Going back never hides or replaces
    // one the person has not seen: it is the agent's output they come back for. Each half
    // below starts from what the person sees, so each stands on its own.
    const T = (await callMcp(app, 'openSession', { mode: 'terminal', cwd: ROOT, name: 'Other' }))
      ?.sessionId
    s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [T]))
    t.check('another tab, T, opens', typeof T === 'string' && same(current(s)?.tabs, [T]), trail(s))

    // Over the deck Z showed when the person left: the new one stays.
    await win.click(rowOf(Z))
    s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [Z]))
    const deckAt = s?.index
    seen = await screenUntil(win, (x) => x.artefactTitle === 'deck', 20_000)
    t.check(
      'a click on Z’s row: Z with its deck',
      same(current(s)?.beside, { [Z]: `artefact:${DECK}` }) && seen.artefactTitle === 'deck',
      { trail: trail(s), seen }
    )
    await win.click(rowOf(T))
    s = await snapshotUntil(win, (x) => x.index === deckAt + 1 && same(current(x)?.tabs, [T]))
    const second = await client.call('clave_open_artefact', { path: SECOND })
    t.check('Z’s agent opens another deck while the person is on T', !toolErrored(second), second)
    await sleep(QUIET_MS)
    s = await snapshot(win)
    seen = await screen(win)
    t.check(
      'the window stays on T and records nothing',
      s?.places.length === deckAt + 2 && s.index === deckAt + 1 && same(seen.tiles, [T]),
      { trail: trail(s), seen }
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === deckAt)
    seen = await screenUntil(win, (x) => x.artefactTitle === 'second', 20_000)
    t.check(
      'Back shows Z with the new deck, not the one Z showed when the person left',
      s?.index === deckAt &&
        same(seen.tiles, [Z]) &&
        seen.artefactTitle === 'second' &&
        same(current(s)?.beside, { [Z]: `artefact:${SECOND}` }),
      { trail: trail(s), seen }
    )
    await win.click(rowOf(T))
    s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [T]))
    await win.click(rowOf(Z))
    s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [Z]))
    seen = await screenUntil(win, (x) => x.artefactTitle === 'second', 20_000)
    t.check(
      'and a later click on Z’s row still shows the new one',
      same(seen.tiles, [Z]) && seen.artefactTitle === 'second',
      { trail: trail(s), seen }
    )

    // Z alone when the person left: Back shows Z WITH the deck its agent opened meanwhile.
    await win.locator('[data-testid="artefact-panel"] [aria-label="Hide artefact"]').first().click()
    s = await snapshotUntil(win, (x) => same(current(x)?.beside, { [Z]: null }))
    const aloneAt = s?.index
    seen = await screenUntil(win, (x) => !x.artefact)
    t.check(
      'the person hides the deck: Z alone, nothing beside it',
      same(current(s)?.tabs, [Z]) && same(current(s)?.beside, { [Z]: null }) && !seen.artefact,
      { trail: trail(s), seen }
    )
    await win.click(rowOf(T))
    s = await snapshotUntil(win, (x) => x.index === aloneAt + 1 && same(current(x)?.tabs, [T]))
    const third = await client.call('clave_open_artefact', { path: THIRD })
    t.check('Z’s agent opens a deck while the person is on T', !toolErrored(third), third)
    await sleep(QUIET_MS)
    s = await snapshot(win)
    seen = await screen(win)
    t.check(
      'the window stays on T and records nothing again',
      s?.places.length === aloneAt + 2 && s.index === aloneAt + 1 && same(seen.tiles, [T]),
      { trail: trail(s), seen }
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === aloneAt)
    seen = await screenUntil(win, (x) => x.artefactTitle === 'third', 20_000)
    t.check(
      'Back shows Z WITH the deck its agent opened meanwhile',
      s?.index === aloneAt &&
        same(seen.tiles, [Z]) &&
        seen.artefactTitle === 'third' &&
        same(current(s)?.beside, { [Z]: `artefact:${THIRD}` }),
      { trail: trail(s), seen }
    )
    await win.click(rowOf(T))
    s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [T]))
    await win.click(rowOf(Z))
    s = await snapshotUntil(win, (x) => same(current(x)?.tabs, [Z]))
    seen = await screenUntil(win, (x) => x.artefactTitle === 'third', 20_000)
    t.check(
      'and a later click on Z’s row still shows it',
      same(seen.tiles, [Z]) && seen.artefactTitle === 'third',
      { trail: trail(s), seen }
    )

    // The person watches the next one open: Back puts back the deck before it, Forward the
    // new one again.
    const watchedAt = s?.index
    const fourth = await client.call('clave_open_artefact', { path: FOURTH })
    t.check('Z’s agent opens a fourth deck while Z shows', !toolErrored(fourth))
    s = await snapshotUntil(
      win,
      (x) => x.index === watchedAt + 1 && current(x)?.beside?.[Z] === `artefact:${FOURTH}`
    )
    seen = await screenUntil(win, (x) => x.artefactTitle === 'fourth', 20_000)
    t.check(
      'a deck opened while the person watches is a new place',
      s?.index === watchedAt + 1 && seen.artefactTitle === 'fourth',
      { trail: trail(s), seen }
    )
    await win.click(BACK)
    s = await snapshotUntil(win, (x) => x.index === watchedAt)
    seen = await screenUntil(win, (x) => x.artefactTitle === 'third', 20_000)
    t.check(
      'Back puts back the deck Z showed before it',
      s?.index === watchedAt && seen.artefactTitle === 'third',
      { trail: trail(s), seen }
    )
    await win.click(FORWARD)
    s = await snapshotUntil(win, (x) => x.index === watchedAt + 1)
    seen = await screenUntil(win, (x) => x.artefactTitle === 'fourth', 20_000)
    t.check(
      'and Forward shows the one opened while the person watched',
      s?.index === watchedAt + 1 && seen.artefactTitle === 'fourth',
      { trail: trail(s), seen }
    )
  } finally {
    await app.close()
  }
}
