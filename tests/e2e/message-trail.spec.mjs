/**
 * The message trail, end to end: the floating box over a tab's terminal that
 * shows where the conversation is.
 *
 * What is guarded: the trail reads the LIVE transcript (seeded under
 * CLAVE_TRANSCRIPTS_ROOT, wired to the tab the way a real tab gets its id —
 * the clear-detected event), walks it with the chevrons, expands to the
 * five-turn window, follows a transcript that grows while the tab is open,
 * scrolls a plain session's xterm to the clicked message, and disappears
 * behind the header toggle. tmux is turned OFF for the spawned tab so the
 * xterm scroll path (the one the renderer owns) is the one under test.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  until,
  killLeakedE2eTmux,
  fixturePath
} from './harness.mjs'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIR = userDataDir('message-trail')
const ROOT = fixturePath('trail-root')
const TRANSCRIPTS = fixturePath('trail-transcripts')
const STEM = 'cc-trail-0001'
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Trail',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const projectDir = (cwd) => cwd.replace(/[/.]/g, '-')
const line = (v) => JSON.stringify(v) + '\n'
const userLine = (text, ts) => line({ type: 'user', timestamp: ts, message: { content: text } })
const assistantLine = (text) =>
  line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  rmSync(TRANSCRIPTS, { recursive: true, force: true })
  const pdir = path.join(TRANSCRIPTS, projectDir(ROOT))
  mkdirSync(pdir, { recursive: true })
  const transcript = path.join(pdir, `${STEM}.jsonl`)
  writeFileSync(
    transcript,
    userLine('Fix the login bug', '2026-08-25T10:00:00.000Z') +
      assistantLine('Let me look at the guard first.') +
      assistantLine('Fixed — the guard now rejects expired tokens.') +
      userLine('Now wire the CSV download', '2026-08-25T10:10:00.000Z') +
      assistantLine('Wired the download through papaparse.') +
      userLine('Ship it to staging', '2026-08-25T10:20:00.000Z') +
      assistantLine('Deployed to staging, all green.')
  )

  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR, { env: { CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS } })
  try {
    // A PLAIN tab (tmux off): the xterm scroll path is the renderer's own.
    await win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    const opened = await callMcp(app, 'openSession', {
      mode: 'terminal',
      cwd: ROOT,
      name: 'trail tab'
    })
    const tabId = opened.sessionId ?? opened.id
    t.check('a tab opened', !!tabId, opened)
    await callMcp(app, 'focus', { sessionId: tabId })
    await win.waitForTimeout(400)

    // No transcript id yet → no trail.
    t.check(
      'without a transcript id there is no trail',
      await win.evaluate(() => !document.querySelector('.message-trail'))
    )

    // The tab learns its transcript id the way a real one does (the
    // clear-detected event main sends), and the trail appears on the newest
    // message with the agent's final line under it.
    await app.evaluate(({ BrowserWindow }, { id, stem }) => {
      BrowserWindow.getAllWindows()[0].webContents.send(`session:clear-detected:${id}`, stem)
    }, { id: tabId, stem: STEM })
    const trail = await until(async () =>
      (await win.evaluate(() => document.querySelector('.message-trail-text')?.textContent)) ?? null
    )
    t.equal('the trail shows the newest human message', trail, 'Ship it to staging')
    t.equal(
      "with the first line of the agent's final answer",
      await win.evaluate(() => document.querySelector('.message-trail-reply')?.textContent),
      'Deployed to staging, all green.'
    )
    t.equal(
      'and the position counter',
      await win.evaluate(() => document.querySelector('.message-trail-count')?.textContent),
      '3/3'
    )

    // --- Chevrons walk the conversation ---
    await win.click('.message-trail [aria-label="Previous message"]')
    const prev = await until(async () => {
      const txt = await win.evaluate(() => document.querySelector('.message-trail-text')?.textContent)
      return txt === 'Now wire the CSV download' ? txt : null
    })
    t.equal('the up chevron steps to the previous message', prev, 'Now wire the CSV download')
    t.equal(
      'the counter follows',
      await win.evaluate(() => document.querySelector('.message-trail-count')?.textContent),
      '2/3'
    )
    t.check(
      'the down chevron is enabled again',
      await win.evaluate(
        () => !document.querySelector('.message-trail [aria-label="Next message"]')?.disabled
      )
    )

    // --- Expand via the hover chevron: the surrounding window, current row marked ---
    await win.hover('.message-trail-line')
    await win.click('.message-trail [aria-label="Expand messages"]')
    await win.waitForTimeout(300)
    const rows = await win.evaluate(() =>
      [...document.querySelectorAll('.message-trail-row .message-trail-text')].map(
        (el) => el.textContent
      )
    )
    t.equal(
      'expanded shows every turn of a short conversation',
      JSON.stringify(rows),
      JSON.stringify(['Fix the login bug', 'Now wire the CSV download', 'Ship it to staging'])
    )
    t.equal(
      'the current row is the selected one',
      await win.evaluate(
        () =>
          document.querySelector('.message-trail-row[data-selected="true"] .message-trail-text')
            ?.textContent
      ),
      'Now wire the CSV download'
    )
    // The selected row is where a big prompt reads whole: unclamped, capped.
    const fullRow = await win.evaluate(() => {
      const el = document.querySelector(
        '.message-trail-row[data-selected="true"] .message-trail-text'
      )
      return el
        ? { whiteSpace: getComputedStyle(el).whiteSpace, capped: getComputedStyle(el).maxHeight !== 'none' }
        : null
    })
    t.equal('the selected row unclamps to wrap', fullRow?.whiteSpace, 'pre-wrap')
    t.check('with a height cap for a scrollbar', fullRow?.capped === true, fullRow)
    await win.click('.message-trail [aria-label="Collapse messages"]')
    await win.waitForTimeout(300)

    // --- A growing transcript reaches the trail (the slow-poll net) ---
    appendFileSync(
      transcript,
      userLine('One more thing: the favicon', '2026-08-25T10:30:00.000Z') +
        assistantLine('Favicon swapped.')
    )
    const grown = await until(
      async () =>
        ((await win.evaluate(() => document.querySelector('.message-trail-count')?.textContent)) ===
        '2/4'
          ? '2/4'
          : null),
      { tries: 40, gapMs: 400 }
    )
    t.equal('a new turn lands while the cursor holds its place', grown, '2/4')

    // --- Click-to-scroll on a plain tab: the xterm buffer is scanned ---
    // Put the message text into the terminal's scrollback with plenty below
    // it, so "scrolled to it" is distinguishable from "at the bottom". The
    // position is asserted against xterm's MODEL (`__claveViewportY`): a
    // hidden test window never syncs the DOM viewport.
    await win.evaluate((id) => {
      window.electronAPI.writeSession(
        id,
        'clear; for i in {1..200}; do echo filler-$i; done; echo "Now wire the CSV download"; for i in {1..150}; do echo below-$i; done\r'
      )
    }, tabId)
    const atBottom = await until(async () => {
      const y = await win.evaluate((id) => window.__claveViewportY?.(id), tabId)
      return typeof y === 'number' && y > 250 ? y : null
    })
    t.check('the output filled the scrollback (viewport rode to the bottom)', atBottom !== null, atBottom)
    await win.click('.message-trail-line')
    const scrolled = await until(async () => {
      const y = await win.evaluate((id) => window.__claveViewportY?.(id), tabId)
      return typeof y === 'number' && y < atBottom - 100 ? y : null
    })
    t.check(
      'clicking the message scrolls the terminal up to it (well off the bottom)',
      scrolled !== null,
      { atBottom, scrolled }
    )

    // --- The header toggle is the one hide; it persists and comes back ---
    await win.click('[title="Hide message trail"]')
    await win.waitForTimeout(200)
    t.check(
      'the header toggle removes the trail',
      await win.evaluate(() => !document.querySelector('.message-trail'))
    )
    t.equal(
      'and persists the choice',
      await win.evaluate(() => localStorage.getItem('clave-message-trail')),
      'false'
    )
    await win.click('[title="Show message trail"]')
    await until(async () =>
      (await win.evaluate(() => !!document.querySelector('.message-trail'))) ? true : null
    )
    t.check('toggling back brings it back', true)
  } finally {
    await app.close()
    killLeakedE2eTmux()
  }
}
