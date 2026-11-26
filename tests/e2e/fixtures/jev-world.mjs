// The world of the decisions (PRDCT-5179) for the specs and the scripts that
// drive the real app on it: a workspace whose trusted `.clave` file declares
// three invented projects (Quill, Atlas, Lumen), each a group with a folder
// of its own and a prompt that says what it is; Claude Code tabs on a
// stand-in `claude` that waits, each started in a folder named for the suite
// so that the harness's sweep ends its tmux session (`openTab`); their
// transcripts seeded where the app reads one (`CLAVE_TRANSCRIPTS_ROOT`); a
// stub of TypeSafe that records what it receives; and the window's roads a
// person takes (the Jev card, the switch, selecting and grouping tabs, a
// rename by hand, a drag into a group).
//
// Shared by `decisions-tab-project.spec.mjs` (the stub),
// `scripts/look-jev-surfaces.mjs` (the stub, for the screenshots) and
// `scripts/check-decisions-real.mjs` (no stub: TypeSafe itself, by hand).
// Every name, path and key here is invented.
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callMcp, fixturePath, until, userDataDir } from '../harness.mjs'

/** The versioned model the stub answers as. */
export const JEV_TEST_MODEL = 'jev-1.14.0'

/** A choice's probabilities over the three projects. */
export const shares = (quill, atlas, lumen) => ({ Quill: quill, Atlas: atlas, Lumen: lumen })

/** The three projects: the groups of the workspace's `.clave` file. */
export const PROJECTS = [
  {
    name: 'Quill',
    cwd: 'quill',
    prompt:
      'Quill is a markdown editor for writers: the ink parser that reads a page, the preview pane beside it and the export to PDF.'
  },
  {
    name: 'Atlas',
    cwd: 'atlas',
    prompt:
      'Atlas is a map tile server: it cuts tiles from a world map, keeps them in a cache and serves them to the viewer by projection.'
  },
  {
    name: 'Lumen',
    cwd: 'lumen',
    prompt:
      'Lumen is the photo library of a small studio: albums, the lightbox where a client picks prints, and the print orders.'
  }
]

/** A tab's name as a folder's: `Quill one` → `quill-one`. */
const slugOf = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** A Quill tab's first message as it must leave the machine: the workspace's
 *  path relative, every path in a home folder dropped wherever it stands, a
 *  closing curly quote or `**` with it (`SAY.quill`, `src/main/decisions/scrub.ts`). */
export const sentFirst = (n) =>
  `Quill ${n}: the ink parser in quill/src/ink.ts drops the heading after a table. My notes are in <path>, read them first. Compare @<path> with the brief “<path> and the list in **<path>.`

/** The paths, the workspace and the tabs' words of one fixture, under the
 *  run's namespace (`name` keeps two users of it apart). */
export function jevWorld(name) {
  const DIR = userDataDir(name)
  const ROOT = fixturePath(`${name}-root`)
  const BIN = fixturePath(`${name}-bin`)
  const TRANSCRIPTS = fixturePath(`${name}-transcripts`)
  const CLAVE = path.join(ROOT, '.clave', 'workspaces', 'default.clave')
  const WS = {
    id: 'dcdcdcdc-0000-4000-8000-000000005179',
    name: 'Decisions',
    rootDir: ROOT,
    profileFile: CLAVE,
    createdAt: 1
  }
  const P = (rel) => path.join(ROOT, rel)

  /** What each kind of tab said and touched. A Quill tab names an absolute
   *  path of the workspace in its FIRST message, and four in a home folder:
   *  one after a space, one after a file mention's `@`, one between curly
   *  quotes and one in Markdown bold. The app makes the first relative and
   *  drops the others before anything leaves. */
  const SAY = {
    quill: (n) => ({
      first: `Quill ${n}: the ink parser in ${P('quill/src/ink.ts')} drops the heading after a table. My notes are in /Users/ada/notes/quill.md, read them first. Compare @/Users/ada/notes/margins.md with the brief “/Users/ada/Clients/Tern/brief.pdf” and the list in **/Users/ada/notes/headings.md**.`,
      latest: [`Run the ink tests again in ${P('quill')}.`],
      touched: [P('quill/src/ink.ts'), P('quill/src/ink.ts'), P('quill/README.md')]
    }),
    atlas: (n) => ({
      first: `Atlas ${n}: the tile cache in ${P('atlas/cache/tiles.go')} serves a stale tile after a reprojection.`,
      latest: [],
      touched: [P('atlas/cache/tiles.go'), P('atlas/cache/tiles_test.go')]
    }),
    close: {
      first: 'The lightbox shows the wrong print size for an order placed from the map view.',
      latest: [],
      touched: [P('lumen/web/lightbox.tsx'), P('atlas/web/map.tsx')]
    },
    train: {
      first: 'Book me a train to Lyon on Friday morning, back on Sunday evening.',
      latest: [],
      touched: []
    }
  }

  /** Every string that would be an absolute path of this machine in a body. */
  function absoluteMarks() {
    const marks = new Set([
      ROOT,
      TRANSCRIPTS,
      os.homedir(),
      '/Users/',
      '/home/',
      '/private/',
      '/tmp/'
    ])
    try {
      marks.add(realpathSync(ROOT))
    } catch {
      // Not created yet: the run creates it before any request.
    }
    return [...marks]
  }

  /** The workspace and its trusted `.clave` file, the stand-in, the
   *  transcripts' folder; everything of a previous run removed first. */
  function seed() {
    for (const dir of [DIR, ROOT, BIN, TRANSCRIPTS]) rmSync(dir, { recursive: true, force: true })
    for (const project of PROJECTS) mkdirSync(P(project.cwd), { recursive: true })
    mkdirSync(path.dirname(CLAVE), { recursive: true })
    writeFileSync(
      CLAVE,
      JSON.stringify(
        {
          groups: PROJECTS.map((p) => ({
            name: p.name,
            cwd: p.cwd,
            prompt: p.prompt,
            sessions: [],
            terminals: []
          }))
        },
        null,
        2
      )
    )
    mkdirSync(BIN, { recursive: true })
    mkdirSync(TRANSCRIPTS, { recursive: true })
    // A `claude` that only waits (a one-shot `-p` answers a line and ends),
    // and a login shell that puts it first on PATH.
    writeFileSync(
      path.join(BIN, 'claude'),
      `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-p" ]; then cat > /dev/null; echo "A stand-in title"; exit 0; fi
done
echo "stand-in claude $CLAVE_SESSION_ID"
exec tail -f /dev/null
`,
      { mode: 0o755 }
    )
    writeFileSync(
      path.join(BIN, 'sh'),
      `#!/bin/sh
export PATH='${BIN}':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
      { mode: 0o755 }
    )
  }

  /** The environment the app needs on this world; `extra` on top. */
  const env = (extra = {}) => ({
    SHELL: path.join(BIN, 'sh'),
    PATH: `${BIN}:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS,
    ...extra
  })

  const transcriptOf = (tab) =>
    path.join(TRANSCRIPTS, tab.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${tab.sid}.jsonl`)

  /** The tab's transcript as Claude Code writes one: what the person said,
   *  and the agent's tool calls with their results. */
  function writeTranscript(tab) {
    const file = transcriptOf(tab)
    mkdirSync(path.dirname(file), { recursive: true })
    const at = (n) => new Date(Date.now() - 3_600_000 + n * 1000).toISOString()
    const lines = [
      {
        type: 'user',
        cwd: tab.cwd,
        timestamp: at(0),
        message: { role: 'user', content: tab.say.first }
      }
    ]
    tab.say.touched.forEach((touched, i) => {
      const id = `toolu_${i}`
      lines.push(
        {
          type: 'assistant',
          timestamp: at(i + 1),
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: touched } }]
          }
        },
        {
          type: 'user',
          timestamp: at(i + 1),
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }]
          }
        }
      )
    })
    for (const said of tab.say.latest)
      lines.push({ type: 'user', timestamp: at(50), message: { role: 'user', content: said } })
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  }

  /** One more thing the person said, appended as a tab that kept working would. */
  function appendSaid(tab, said) {
    appendFileSync(
      transcriptOf(tab),
      JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: said }
      }) + '\n'
    )
  }

  /** A Claude Code tab on the stand-in, out of any group, and its transcript.
   *  The tab starts in a folder of its own inside `folder` (its project's,
   *  or the root), named for the suite: `clave-e2e-tab-<its name>`. The app
   *  names a tab's tmux session after its folder, the session outlives the
   *  app on the shared socket, and the harness's sweep takes only a session
   *  named for the suite. A decision reads the tab's folder only to find its
   *  transcript, which is filed under it: what it sends is the same. */
  async function openTab(app, win, tabName, folder, say) {
    const cwd = path.join(folder, `clave-e2e-tab-${slugOf(tabName)}`)
    mkdirSync(cwd, { recursive: true })
    const opened = await callMcp(app, 'openSession', {
      cwd,
      mode: 'claude',
      name: tabName,
      profile: 'builtin-claude'
    })
    const id = opened?.sessionId
    if (!id) throw new Error(`openSession for ${tabName} answered ${JSON.stringify(opened)}`)
    const sid = await until(async () => (await sessionOf(win, id))?.claudeSessionId ?? null, {
      tries: 120,
      gapMs: 250
    })
    if (!sid) throw new Error(`the tab ${tabName} has no conversation id`)
    await win.locator(rowSel(id)).first().waitFor()
    const tab = { id, sid, name: tabName, cwd, say }
    writeTranscript(tab)
    return tab
  }

  return {
    DIR,
    ROOT,
    BIN,
    TRANSCRIPTS,
    CLAVE,
    WS,
    P,
    SAY,
    absoluteMarks,
    seed,
    env,
    writeTranscript,
    appendSaid,
    openTab
  }
}

// ── The stub of TypeSafe ────────────────────────────────────────────────────

function answerOf(entry, model) {
  const ranked = Object.entries(entry.probabilities).sort((a, b) => b[1] - a[1])
  return {
    model,
    answers: {
      project: {
        type: 'choice',
        choice: ranked[0][0],
        confidence: ranked[0][1],
        probabilities: entry.probabilities
      },
      fits: { type: 'noul', noul: entry.fits }
    },
    usage: { input_tokens: 812, output_tokens: 4 }
  }
}

/** `GET /v1/models` (200 for the good key, 401 in TypeSafe's words for any
 *  other) and `POST /v1/systemone` (the table's answer for the first word of
 *  it the tab's first message holds). Every request is recorded: its method,
 *  its path, whether the bearer is exactly the good key, its body. While
 *  `hold()` is on, the decisions' answers wait for `release()`. */
export function startJevStub({ good, model = JEV_TEST_MODEL }) {
  const seen = []
  const waiting = []
  const state = { holding: false, table: {} }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://stub')
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = { unparsed: raw }
      }
      const authOk = req.headers.authorization === `Bearer ${good}`
      seen.push({ method: req.method, path: pathname, authOk, body, raw })
      const json = (status, payload) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
      if (!authOk) return json(401, { detail: 'Invalid API key' })
      if (req.method === 'GET' && pathname === '/v1/models')
        return json(200, { data: [{ id: model }, { id: 'jev-latest' }] })
      if (req.method === 'POST' && pathname === '/v1/systemone') {
        const first = String(body?.state?.sessions?.[0]?.first_message ?? '').toLowerCase()
        const word = Object.keys(state.table).find((w) => first.includes(w))
        const answer = () =>
          json(
            200,
            answerOf(
              word ? state.table[word] : { probabilities: shares(0.34, 0.33, 0.33), fits: 0.1 },
              model
            )
          )
        if (state.holding) return waiting.push(answer)
        return answer()
      }
      return json(404, { detail: 'Not Found' })
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        seen,
        /** The decisions asked so far, oldest first. */
        decisions: () => seen.filter((r) => r.path === '/v1/systemone'),
        /** The table for the steps to come, merged over the last one. */
        answer: (entries) => Object.assign(state.table, entries),
        hold: () => (state.holding = true),
        release: () => {
          state.holding = false
          for (const answer of waiting.splice(0)) answer()
        },
        close: () => new Promise((done) => server.close(() => done()))
      })
    )
  )
}

// ── The window, as a person drives it ───────────────────────────────────────

export const rowSel = (id) => `[data-sidebar-item-id="${id}"]`
export const textOf = async (locator) => ((await locator.textContent()) ?? '').trim()

export const groupsNow = (win) =>
  win.evaluate(() =>
    window.__claveSessionStoreForTests.getState().groups.map((g) => ({
      id: g.id,
      name: g.name,
      sessionIds: [...g.sessionIds],
      autoNamed: g.autoNamed === true
    }))
  )
export const groupOfTab = async (win, id) =>
  (await groupsNow(win)).find((g) => g.sessionIds.includes(id)) ?? null
export const sessionOf = (win, id) =>
  win.evaluate((id) => {
    const s = window.__claveSessionStoreForTests.getState().sessions.find((x) => x.id === id)
    return s
      ? { id: s.id, claudeSessionId: s.claudeSessionId ?? null, projects: s.projects ?? null }
      : null
  }, id)
export const sessionIdsNow = (win) =>
  win.evaluate(() => window.__claveSessionStoreForTests.getState().sessions.map((s) => s.id))

/** The name the group's row shows. */
export const shownName = (win, groupId) =>
  win
    .locator(`${rowSel(groupId)} span.truncate`)
    .first()
    .textContent({ timeout: 5000 })
    .then((text) => (text ?? '').trim())
    .catch(() => null)
export const waitName = async (win, groupId, name, tries = 80) =>
  (await until(async () => ((await shownName(win, groupId)) === name ? name : null), {
    tries,
    gapMs: 125
  })) ?? (await shownName(win, groupId))
export const isGroupN = (name) => /^Group \d+$/.test(name ?? '')

/** The suggestion chips on a group's row, as a person reads them. */
export const chipsOf = (win, groupId) =>
  win.evaluate(
    (id) =>
      [...document.querySelectorAll(`[data-group-suggestions="${id}"] .badge`)].map((b) =>
        (b.textContent ?? '').trim()
      ),
    groupId
  )

export async function openSettings(win, section) {
  const page = win.locator(`[data-settings-page="${section}"]`)
  if (!(await page.isVisible().catch(() => false))) {
    if (
      !(await win
        .locator('[data-settings-nav-row]')
        .first()
        .isVisible()
        .catch(() => false))
    )
      await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
    await win.locator(`[data-settings-nav-row="${section}"]`).click()
  }
  await page.waitFor()
  return page
}
export async function openJevCard(win) {
  const page = await openSettings(win, 'integrations')
  const card = page.locator('[data-integration="jev"]')
  await card.waitFor()
  return card
}
export const backToSessions = async (win) => {
  await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
  await win
    .locator('[data-settings-nav-row]')
    .first()
    .waitFor({ state: 'detached' })
    .catch(() => {})
}

export async function pasteJev(card, key) {
  const field = card.locator('[data-testid="jev-key-input"]')
  await field.waitFor()
  await field.fill(key)
  await card.locator('[data-testid="jev-key-save"]').click()
}
export const cardLine = async (card, testId) => {
  const line = card.locator(`[data-testid="${testId}"]`)
  return (await line.count()) ? (await textOf(line)) || null : null
}
/** The card's « Checked on … » line once the check has passed, else null. */
export const checkedLine = async (card) => {
  const line = await cardLine(card, 'jev-checked')
  return line && line.startsWith('Checked on ') ? line : null
}

export async function setTabProject(win, enabled) {
  const page = await openSettings(win, 'helpers')
  const row = page.locator('[data-decision-row="tab-project"]')
  await row.waitFor()
  const toggle = row.getByRole('switch', { name: 'Tab project' })
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click()
  return until(async () =>
    (await toggle.getAttribute('aria-checked')) === String(enabled) ? true : null
  )
}

/** Select these tabs the way a person does: a click, then Cmd-clicks. */
export async function selectTabs(win, ids) {
  await win.locator(rowSel(ids[0])).first().click()
  for (const id of ids.slice(1))
    await win
      .locator(rowSel(id))
      .first()
      .click({ modifiers: ['Meta'] })
  const selected = await until(async () => {
    const now = await win.evaluate(() => [
      ...window.__claveSessionStoreForTests.getState().selectedSessionIds
    ])
    return now.length === ids.length && ids.every((id) => now.includes(id)) ? true : null
  })
  if (!selected) throw new Error(`the tabs ${ids.join(', ')} could not be selected`)
}

const waitGroupOf = async (win, ids) => {
  const group = await until(
    async () => {
      const g = await groupOfTab(win, ids[0])
      return g && ids.every((id) => g.sessionIds.includes(id)) ? g : null
    },
    { tries: 60, gapMs: 100 }
  )
  if (!group) throw new Error(`no group holds ${ids.join(', ')}`)
  return group
}

/** The keymap's « Group selected sessions » (Mod+G). */
export async function groupByKeymap(win, ids) {
  await selectTabs(win, ids)
  await win.keyboard.press('Meta+g')
  return waitGroupOf(win, ids)
}

/** The sidebar menu's « Group », on the selected tabs. */
export async function groupByMenu(win, ids) {
  await selectTabs(win, ids)
  await win
    .locator(rowSel(ids[ids.length - 1]))
    .first()
    .click({ button: 'right' })
  await win
    .getByRole('menuitem', { name: /^Group(\W|$)/ })
    .first()
    .click()
  return waitGroupOf(win, ids)
}

/** The keymap's « Ungroup selected sessions » (Mod+Alt+G), on a group's tabs. */
export async function ungroupByKeymap(win, group) {
  await selectTabs(win, group.sessionIds)
  await win.keyboard.press('Meta+Alt+g')
  return until(async () => ((await groupsNow(win)).some((g) => g.id === group.id) ? null : true))
}

/** A person's rename, from the group's menu. */
export async function renameByHand(win, groupId, name) {
  await win
    .locator(`${rowSel(groupId)} .group-header`)
    .first()
    .click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Rename' }).first().click()
  const field = win.locator(`${rowSel(groupId)} input`).first()
  await field.waitFor()
  await field.fill(name)
  await field.press('Enter')
}

async function centerOf(win, selector, yFraction = 0.5) {
  const box = await win.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height * yFraction }
}

/** A real pointer drag of a tab's row onto a group's header (its lower part:
 *  inside), in steps past the drag threshold, as sidebar-dnd does. */
export async function dragInto(win, tabId, groupId) {
  const from = await centerOf(win, rowSel(tabId))
  await win.mouse.move(from.x, from.y)
  await win.mouse.down()
  let at = from
  for (let round = 0; round < 3; round++) {
    const to = await centerOf(win, `${rowSel(groupId)} .group-header`, 0.75)
    for (let i = 1; i <= 10; i++) {
      await win.mouse.move(at.x + ((to.x - at.x) * i) / 10, at.y + ((to.y - at.y) * i) / 10)
      await win.waitForTimeout(20)
    }
    at = to
    await win.waitForTimeout(150)
  }
  await win.mouse.up()
  await win.waitForTimeout(600)
}
