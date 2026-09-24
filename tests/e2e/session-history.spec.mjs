/**
 * The session history (PRDCT-1738, reframed by PRDCT-1766), end to end.
 *
 * Two things are being guarded. The LINK between a closed session and the
 * group it lived in, which nothing durable used to hold: the ledger row is
 * written AT THE PLACEMENT (a tab opened in a group, then moved out and back
 * in, leaves three rows carrying three groups), and the dialog reads that
 * ledger back — group matched by name across relaunches, rows ordered by the
 * last human message read off the transcript's tail, a cleaned-up transcript
 * greyed, a click that spawns `claude --resume <id>` into the group. The
 * resume assertion taps the pty:spawn boundary (PRDCT-1677's spy): the UI
 * can look right while nothing is handed on.
 *
 * And the UNIVERSE: the dialog opens on the whole store — every claude
 * transcript this Mac holds plus the codex rollouts, workspace-scoped by
 * each conversation's own cwd — with groups as mere filters over it, the
 * footer counting by provider, the search toggles (Human and Agent on by
 * default, Tools off) searching inside whatever is in scope, and codex rows
 * listed, searchable and inert.
 *
 * Transcripts are seeded under private roots through CLAVE_TRANSCRIPTS_ROOT
 * and CLAVE_CODEX_ROOT, never in the real ~/.claude or ~/.codex.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  callMcp,
  spyPtySpawn,
  until,
  killLeakedE2eTmux,
  fixturePath
} from './harness.mjs'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const DIR = userDataDir('session-history')
const ROOT = fixturePath('history-root')
const TRANSCRIPTS = fixturePath('history-transcripts')
const CODEX = fixturePath('history-codex')
const FOREIGN = fixturePath('foreign-root')
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000e',
  name: 'History',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const OTHER_WS = 'ffffffff-0000-4000-8000-00000000000f'

/** Same encoding the app uses for a cwd's project dir. */
const projectDir = (cwd) => cwd.replace(/[/.]/g, '-')

function ledgerRow(over) {
  return JSON.stringify({
    v: 1,
    kind: 'placed',
    ts: '2026-08-20T10:00:00.000Z',
    sessionId: 'tab-x',
    claudeSessionId: null,
    name: 'seeded',
    cwd: ROOT,
    mode: 'claude',
    model: null,
    workspaceId: WS.id,
    groupId: 'group-old-alpha',
    groupName: 'Alpha',
    ...over
  })
}

function transcript(lines) {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

/** Every session record on disk (the tmux sidecars), so a spec can read a
 *  record's transcript id. */
function sessionRecords() {
  const dir = path.join(DIR, 'session-records')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')))
}

function readLedger() {
  const f = path.join(DIR, 'session-history', 'ledger.jsonl')
  if (!existsSync(f)) return []
  // The seed carries a deliberately malformed line (the app must skip it, not
  // choke); this reader skips it too.
  return readFileSync(f, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

/** Is a web view actually PAINTED over the main pane? A mounted-but-hidden view
 *  panel (see PRDCT-2122) is still in the DOM, so this asks what is on top at the
 *  centre of the pane rather than what merely exists.
 *
 *  The guard is the PAIR of calls below, not either alone: the positive one
 *  ("the group's web view covers the pane") is what proves this helper can still
 *  see a view that IS on top — delete the grid's `visibility` rule in
 *  TerminalGrid.tsx, so no view can ever cover the terminal, and it goes red. A
 *  lone negative assertion would pass just as well on a helper that had quietly
 *  stopped finding anything. */
function webViewCoversPane(win) {
  return win.evaluate(() => {
    const frame = document.querySelector('iframe, webview')
    if (!frame) return false
    const r = frame.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    for (let el = top; el; el = el.parentElement) {
      if (el === frame) return true
    }
    return false
  })
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  rmSync(TRANSCRIPTS, { recursive: true, force: true })
  const pdir = path.join(TRANSCRIPTS, projectDir(ROOT))
  mkdirSync(pdir, { recursive: true })

  // Three conversations that lived in an "Alpha" group under an OLD group id
  // (the group has since been relaunched), one in "Beta", one in another
  // workspace. `alpha-2` was opened first but spoken to last; `alpha-1` the
  // reverse — so "last message" and "opened" order them differently.
  // `alpha-gone` has no transcript on disk any more.
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  mkdirSync(path.join(DIR, 'session-history'), { recursive: true })
  writeFileSync(
    path.join(DIR, 'session-history', 'ledger.jsonl'),
    [
      ledgerRow({ ts: '2026-08-20T08:00:00.000Z', sessionId: 'tab-gone', claudeSessionId: 'cc-alpha-gone', name: 'gone session' }),
      ledgerRow({ ts: '2026-08-20T09:00:00.000Z', sessionId: 'tab-2', claudeSessionId: 'cc-alpha-2', name: 'second alpha' }),
      ledgerRow({ ts: '2026-08-20T11:00:00.000Z', sessionId: 'tab-1', claudeSessionId: 'cc-alpha-1', name: 'first alpha' }),
      ledgerRow({ ts: '2026-08-20T11:30:00.000Z', sessionId: 'tab-1', claudeSessionId: 'cc-alpha-1', name: 'first alpha', kind: 'closed' }),
      ledgerRow({ ts: '2026-08-20T12:00:00.000Z', sessionId: 'tab-b', claudeSessionId: 'cc-beta-1', name: 'beta work', groupId: 'group-old-beta', groupName: 'Beta' }),
      ledgerRow({ ts: '2026-08-20T13:00:00.000Z', sessionId: 'tab-o', claudeSessionId: 'cc-other', name: 'elsewhere', workspaceId: OTHER_WS }),
      'not json at all'
    ].join('\n') + '\n'
  )
  writeFileSync(
    path.join(pdir, 'cc-alpha-1.jsonl'),
    transcript([
      { type: 'user', timestamp: '2026-08-21T10:00:00.000Z', message: { content: 'Fix the login bug' } },
      { type: 'ai-title', aiTitle: 'Login bug fix' },
      { type: 'assistant', timestamp: '2026-08-21T10:04:00.000Z', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/src/auth/passkey-guard.ts' } }] } },
      { type: 'user', timestamp: '2026-08-21T10:05:00.000Z', toolUseResult: true, message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'last-prompt', lastPrompt: 'Fix the login bug' }
    ])
  )
  writeFileSync(
    path.join(pdir, 'cc-alpha-2.jsonl'),
    transcript([
      { type: 'user', timestamp: '2026-08-22T10:00:00.000Z', message: { content: 'Add the export button' } },
      { type: 'ai-title', aiTitle: 'Export button' },
      { type: 'user', timestamp: '2026-08-23T09:00:00.000Z', message: { content: [{ type: 'text', text: 'Now wire the CSV download' }] } },
      { type: 'assistant', timestamp: '2026-08-23T09:01:00.000Z', message: { content: [{ type: 'thinking', thinking: 'papaparse would do' }, { type: 'text', text: 'Wired the download through papaparse.' }] } },
      { type: 'last-prompt', lastPrompt: 'Now wire the CSV download' }
    ])
  )
  // A conversation Clave never ran (no ledger row), in this workspace's
  // root — the Everything toggle's material — and one in a FOREIGN root,
  // which the workspace scoping must keep out even under Everything.
  writeFileSync(
    path.join(pdir, 'cc-outside.jsonl'),
    transcript([
      { type: 'user', timestamp: '2026-08-24T08:00:00.000Z', cwd: ROOT, message: { content: 'Ran from a plain terminal' } },
      { type: 'ai-title', aiTitle: 'Outside conversation' },
      { type: 'last-prompt', lastPrompt: 'Ran from a plain terminal' }
    ])
  )
  const foreignDir = path.join(TRANSCRIPTS, projectDir(FOREIGN))
  mkdirSync(foreignDir, { recursive: true })
  writeFileSync(
    path.join(foreignDir, 'cc-foreign.jsonl'),
    transcript([
      { type: 'user', timestamp: '2026-08-24T08:00:00.000Z', cwd: FOREIGN, message: { content: 'Foreign workspace' } },
      { type: 'ai-title', aiTitle: 'Foreign conversation' },
      { type: 'last-prompt', lastPrompt: 'Foreign workspace' }
    ])
  )
  // A transcript with NO cwd anywhere: scoped by its store dir name, never
  // resumable. One in our dir (listed, inert) and one in the foreign dir
  // (never listed here).
  writeFileSync(
    path.join(pdir, 'cc-nocwd.jsonl'),
    transcript([
      { type: 'mode', mode: 'default' },
      { type: 'ai-title', aiTitle: 'Folder unknown' },
      { type: 'last-prompt', lastPrompt: 'no cwd anywhere' }
    ])
  )
  writeFileSync(
    path.join(foreignDir, 'cc-nocwd-foreign.jsonl'),
    transcript([
      { type: 'mode', mode: 'default' },
      { type: 'ai-title', aiTitle: 'Foreign folder unknown' },
      { type: 'last-prompt', lastPrompt: 'foreign no cwd' }
    ])
  )
  // The same stem under TWO project dirs (a resume-from-a-subdir stub): one
  // conversation, one row, the larger transcript wins.
  writeFileSync(path.join(foreignDir, 'cc-dup.jsonl'), transcript([{ type: 'mode', mode: 'default' }]))
  writeFileSync(
    path.join(pdir, 'cc-dup.jsonl'),
    transcript([
      { type: 'user', timestamp: '2026-08-23T07:00:00.000Z', cwd: ROOT, message: { content: 'The duplicated conversation' } },
      { type: 'ai-title', aiTitle: 'Duplicated stem' },
      { type: 'last-prompt', lastPrompt: 'The duplicated conversation, big copy' }
    ])
  )
  writeFileSync(
    path.join(pdir, 'cc-beta-1.jsonl'),
    transcript([
      { type: 'user', timestamp: '2026-08-22T12:00:00.000Z', message: { content: 'Beta things' } },
      { type: 'ai-title', aiTitle: 'Beta things' },
      { type: 'last-prompt', lastPrompt: 'Beta things' }
    ])
  )
  // One of Clave's OWN tab-title helper calls (`claude -p` leaves a
  // transcript like any conversation): the app's plumbing, never a row.
  writeFileSync(
    path.join(pdir, 'cc-titlegen.jsonl'),
    transcript([
      { type: 'user', timestamp: '2026-08-24T09:00:00.000Z', cwd: ROOT, message: { content: 'Generate a short 2-4 word title for this Claude Code terminal session based on what the user asked.\nRules:\n- Return ONLY the title' } },
      { type: 'last-prompt', lastPrompt: 'Generate a short 2-4 word title for this Claude Code terminal session based on what the user asked.\nRules:\n- Return ONLY the title' }
    ])
  )
  // The codex store: a user thread in this workspace's root (listed, inert),
  // a subagent thread (an inner thread, never a row), and a user thread in a
  // foreign root (kept out by the workspace scoping).
  rmSync(CODEX, { recursive: true, force: true })
  const codexDay = path.join(CODEX, '2026', '08', '25')
  mkdirSync(codexDay, { recursive: true })
  const codexMeta = (over) => ({
    timestamp: '2026-08-25T08:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'cx-0001',
      timestamp: '2026-08-25T08:00:00.000Z',
      cwd: ROOT,
      originator: 'codex-tui',
      thread_source: 'user',
      ...over
    }
  })
  const codexUser = (text) => ({
    timestamp: '2026-08-25T08:01:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  })
  writeFileSync(
    path.join(codexDay, 'rollout-2026-08-25T08-00-00-cx-0001.jsonl'),
    transcript([codexMeta({}), codexUser('Sweep the codex garden please')])
  )
  writeFileSync(
    path.join(codexDay, 'rollout-2026-08-25T08-05-00-cx-sub.jsonl'),
    transcript([codexMeta({ id: 'cx-sub', thread_source: 'subagent' }), codexUser('inner thread')])
  )
  writeFileSync(
    path.join(codexDay, 'rollout-2026-08-25T08-10-00-cx-foreign.jsonl'),
    transcript([
      codexMeta({ id: 'cx-foreign', cwd: FOREIGN }),
      codexUser('foreign codex thread')
    ])
  )
  // A thread whose meta carries NO cwd cannot be scoped to any workspace:
  // unlisted, never shown in every one.
  writeFileSync(
    path.join(codexDay, 'rollout-2026-08-25T08-15-00-cx-nocwd.jsonl'),
    transcript([codexMeta({ id: 'cx-nocwd', cwd: undefined }), codexUser('unattributable thread')])
  )
  // A second rollout carrying the SAME thread id: one conversation, one row.
  writeFileSync(
    path.join(codexDay, 'rollout-2026-08-25T09-00-00-cx-dup.jsonl'),
    transcript([codexMeta({}), codexUser('the duplicated codex thread')])
  )

  const { app, win } = await launchApp(DIR, {
    env: { CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS, CLAVE_CODEX_ROOT: CODEX }
  })
  try {
    // --- The ledger is written at the placement, whatever the mutator ---
    const created = await callMcp(app, 'createGroup', { name: 'Alpha' })
    const liveGroupId = created.groupId
    t.check('a live group named like the old one exists (new id)', !!liveGroupId && liveGroupId !== 'group-old-alpha', liveGroupId)
    const opened = await callMcp(app, 'openSession', { groupId: liveGroupId, mode: 'terminal', cwd: ROOT, name: 'shell in alpha' })
    const tabId = opened.sessionId ?? opened.id
    t.check('a terminal opened inside the group', !!tabId, opened)
    // A second tab keeps the group alive while the first is moved out: a
    // group emptied by a move is dropped, by design.
    await callMcp(app, 'openSession', { groupId: liveGroupId, mode: 'terminal', cwd: ROOT, name: 'anchor' })

    const placedIn = await until(() => {
      const r = readLedger().find((row) => row.sessionId === tabId && row.groupId === liveGroupId)
      return r ?? null
    })
    t.check('opening a tab in a group writes a placed row carrying the group', !!placedIn, readLedger().filter((r) => r.sessionId === tabId))
    t.equal('the row names the group', placedIn?.groupName, 'Alpha')
    t.equal('a terminal has no transcript id', placedIn?.claudeSessionId, null)
    t.equal('the row is stamped with the workspace', placedIn?.workspaceId, WS.id)

    await callMcp(app, 'moveSession', { sessionId: tabId, groupId: 'root' })
    const movedOut = await until(() => readLedger().find((row) => row.sessionId === tabId && row.groupId === null) ?? null)
    t.check('moving the tab OUT of the group is a row at the move (group null)', !!movedOut)
    await callMcp(app, 'moveSession', { sessionId: tabId, groupId: liveGroupId })
    const movedBack = await until(() => {
      const rows = readLedger().filter((row) => row.sessionId === tabId && row.groupId === liveGroupId)
      return rows.length >= 2 ? rows : null
    })
    t.check('moving it back in is another row — the drag-later case is recorded', !!movedBack)

    // --- A /clear rotates the transcript id: record and store both follow ---
    await win.evaluate((id) => window.electronAPI.setSessionClaudeSessionId(id, 'rotated-0001'), tabId)
    const rec1 = await until(() => sessionRecords().find((r) => r.id === tabId && r.claudeSessionId === 'rotated-0001') ?? null)
    t.check('the session record on disk carries the rotated transcript id', !!rec1, sessionRecords().find((r) => r.id === tabId))
    await win.evaluate((id) => window.electronAPI.setSessionClaudeSessionId(id, '../evil'), tabId)
    await win.waitForTimeout(300)
    t.equal('an id outside the alphabet is refused by the record', sessionRecords().find((r) => r.id === tabId)?.claudeSessionId, 'rotated-0001')
    // The renderer half: the clear-detected event, sent the way main sends
    // it, lands the new id in the store — visible as a ledger row.
    await callMcp(app, 'focus', { sessionId: tabId })
    await win.waitForTimeout(400)
    await app.evaluate(({ BrowserWindow }, { id, stem }) => {
      BrowserWindow.getAllWindows()[0].webContents.send(`session:clear-detected:${id}`, stem)
    }, { id: tabId, stem: 'rotated-0002' })
    const rotatedRow = await until(() => readLedger().find((r) => r.sessionId === tabId && r.claudeSessionId === 'rotated-0002') ?? null)
    t.check('the store follows the rotation: a ledger row carries the new id', !!rotatedRow)
    await app.evaluate(({ BrowserWindow }, { id, stem }) => {
      BrowserWindow.getAllWindows()[0].webContents.send(`session:clear-detected:${id}`, stem)
    }, { id: tabId, stem: 'bad/../stem' })
    await win.waitForTimeout(400)
    // Not merely "the bad string is absent": the ledger normalizer scrubs
    // any out-of-alphabet id to null on the way in, so the observable is the
    // tab KEEPING its previous id — a scrubbed row would say null.
    const lastRow = readLedger().filter((r) => r.sessionId === tabId).pop()
    t.equal('an invalid stem never reaches the store: the tab keeps its id', lastRow?.claudeSessionId, 'rotated-0002')

    // --- Right-click the group → History, preselected ---
    await win.click(`[data-sidebar-item-id="${liveGroupId}"] > button`, { button: 'right' })
    await win.waitForTimeout(350)
    const menuLabels = await win.evaluate(() =>
      [...document.querySelectorAll('.menu-surface .menu-item')].map((el) => el.textContent?.trim() ?? '')
    )
    t.check("the group's context menu carries History", menuLabels.some((l) => l.startsWith('History')), menuLabels)
    await win.locator('.menu-surface .menu-item', { hasText: 'History' }).click()
    await win.waitForSelector('[data-history-dialog]', { timeout: 5000 })
    await win.waitForSelector('[data-history-row]', { timeout: 5000 })
    const state = await win.evaluate(() => ({
      chip: document.querySelector('[data-history-chip][data-selected="true"]')?.getAttribute('data-history-chip') ?? null,
      rows: [...document.querySelectorAll('[data-history-row]')].map((el) => el.getAttribute('data-history-row')),
      titles: [...document.querySelectorAll('[data-history-row] .history-row-title')].map((el) => el.textContent),
      prompts: [...document.querySelectorAll('[data-history-row] .history-row-prompt')].map((el) => el.textContent),
      missing: [...document.querySelectorAll('[data-history-row][data-missing="true"]')].map((el) => el.getAttribute('data-history-row'))
    }))
    t.equal('the dialog opens with the group chip preselected', state.chip, liveGroupId)
    t.equal(
      'the group (matched by NAME across its relaunch) lists its sessions, last human message first',
      JSON.stringify(state.rows),
      JSON.stringify(['cc-alpha-2', 'cc-alpha-1', 'cc-alpha-gone'])
    )
    t.check('Beta and the other workspace are not in it', !state.rows.includes('cc-beta-1') && !state.rows.includes('cc-other'))
    t.equal("a row's title is Claude Code's own ai-title", state.titles[0], 'Export button')
    t.equal('a row shows the last prompt from the transcript tail', state.prompts[0], 'Now wire the CSV download')
    t.equal('the ledger name stands in when there is no transcript', state.titles[2], 'gone session')
    t.equal('a cleaned-up transcript is greyed', JSON.stringify(state.missing), JSON.stringify(['cc-alpha-gone']))

    // --- The filter, instant over the rows' own text ---
    await win.fill('[data-history-filter]', 'zzz-no-such-thing')
    const noMatch = await win.evaluate(() => [...document.querySelectorAll('[data-history-row]')].map((el) => el.getAttribute('data-history-row')))
    t.equal('a query nothing matches empties the list instantly', JSON.stringify(noMatch), JSON.stringify([]))
    await win.fill('[data-history-filter]', '')

    // --- The transcript search: independent toggles, Human + Agent on by default ---
    const rowsAndHits = () =>
      win.evaluate(() => ({
        rows: [...document.querySelectorAll('[data-history-row]')].map((el) => el.getAttribute('data-history-row')),
        hits: [...document.querySelectorAll('[data-history-hit]')].map((el) => el.textContent),
        footer: document.querySelector('[data-history-footer]')?.textContent ?? ''
      }))
    // Wait for THIS search: the debounce has to fire and the footer must
    // settle on a hit count — while a search runs it says "searching …".
    const searched = async () => {
      await win.waitForTimeout(400)
      return until(async () => {
        const r = await rowsAndHits()
        return /\d+ hits? in/.test(r.footer) ? r : null
      })
    }
    const toggleState = () =>
      win.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('[data-history-scope]')].map((el) => [
            el.getAttribute('data-history-scope'),
            el.getAttribute('data-selected') === 'true'
          ])
        )
      )
    t.equal('Human and Agent are on by default, Tools off', JSON.stringify(await toggleState()), JSON.stringify({ human: true, agent: true, tools: false }))

    await win.click('[data-history-scope="agent"]')
    t.equal('a toggle turns off on a click, the others untouched', JSON.stringify(await toggleState()), JSON.stringify({ human: true, agent: false, tools: false }))
    await win.fill('[data-history-filter]', 'csv')
    let r = await searched()
    t.equal('Human toggle: the query is found in what the human typed', JSON.stringify(r?.rows), JSON.stringify(['cc-alpha-2']))
    t.check('the row shows the matching excerpt', (r?.hits ?? []).some((h) => h?.includes('CSV download')), r?.hits)
    t.check('the footer counts the hits', /1 hit in 1 of \d+ transcripts?/.test(r?.footer ?? ''), r?.footer)

    await win.fill('[data-history-filter]', 'papaparse')
    r = await searched()
    t.equal('a word only the agent said is not a Human hit', JSON.stringify(r?.rows), JSON.stringify([]))
    await win.click('[data-history-scope="agent"]')
    r = await searched()
    t.equal('the Agent toggle back on finds it (in the answer, never the thinking)', JSON.stringify(r?.rows), JSON.stringify(['cc-alpha-2']))
    t.check('with the excerpt marked', (r?.hits ?? []).some((h) => h?.includes('papaparse')), r?.hits)

    await win.fill('[data-history-filter]', 'passkey-guard')
    r = await searched()
    t.equal('a path only in a tool input is neither a Human nor an Agent hit', JSON.stringify(r?.rows), JSON.stringify([]))
    await win.click('[data-history-scope="tools"]')
    r = await searched()
    t.equal('the Tools toggle finds it', JSON.stringify(r?.rows), JSON.stringify(['cc-alpha-1']))
    await win.click('[data-history-scope="tools"]')

    // Every toggle off: the field is a plain filter, nothing is searched.
    await win.click('[data-history-scope="human"]')
    await win.click('[data-history-scope="agent"]')
    await win.fill('[data-history-filter]', 'csv')
    await win.waitForTimeout(600)
    const plain = await rowsAndHits()
    t.equal('with every toggle off the field still filters by the row text', JSON.stringify(plain.rows), JSON.stringify(['cc-alpha-2']))
    t.check('and nothing was searched: the footer just counts what is shown', /· 1 shown$/.test(plain.footer), plain.footer)
    await win.click('[data-history-scope="human"]')
    await win.click('[data-history-scope="agent"]')

    // A superseded search is cancelled: the dialog sends history:search-cancel
    // with its per-window request id the moment the query changes.
    await app.evaluate(({ ipcMain }) => {
      globalThis.__e2eCancels = []
      ipcMain.on('history:search-cancel', (_e, id) => globalThis.__e2eCancels.push(id))
    })
    await win.fill('[data-history-filter]', 'passkey')
    await win.waitForTimeout(400)
    await win.fill('[data-history-filter]', 'passkey-gu')
    await win.waitForTimeout(600)
    const cancels = await app.evaluate(() => globalThis.__e2eCancels ?? [])
    t.check('changing the query cancels the superseded search', cancels.length >= 1, cancels)
    t.check('with a per-window request id', cancels.every((id) => /^history-[a-z0-9]+-\d+$/.test(id)), cancels)

    // Bounded to the rows in scope: a word only in Beta's transcript is not
    // found while the Alpha chip is selected, and only Alpha's two
    // transcripts were read (the gone one has none).
    await win.fill('[data-history-filter]', 'Beta things')
    r = await searched()
    t.equal('a group search never reads outside the group', JSON.stringify(r?.rows), JSON.stringify([]))
    t.check('and it read exactly the group\'s transcripts', (r?.footer ?? '').includes('0 hits in 0 of 2 transcripts'), r?.footer)

    // The union: a query matching only the rows' OWN text (a group name)
    // keeps those rows on screen while the transcript search finds nothing,
    // and the footer says both truths.
    await win.fill('[data-history-filter]', 'Alpha')
    r = await searched()
    t.equal('a row-text match shows through a hitless transcript search', JSON.stringify(r?.rows), JSON.stringify(['cc-alpha-2', 'cc-alpha-1', 'cc-alpha-gone']))
    t.check('and the footer carries the hit count AND the shown count', /0 hits in 0 of \d+ transcripts? · 3 shown/.test(r?.footer ?? ''), r?.footer)

    await win.fill('[data-history-filter]', '')
    await win.click('[data-history-chip="all"]')
    const all = await win.evaluate(() => [...document.querySelectorAll('[data-history-row]')].map((el) => el.getAttribute('data-history-row')))
    t.check('All shows Beta too, never the other workspace', all.includes('cc-beta-1') && !all.includes('cc-other'), all)
    await win.click(`[data-history-chip="${liveGroupId}"]`)

    // --- Resume: the spawn carries --resume <id>, and the tab lands in the group ---
    // Another group holds the selection: `addSession` would nest a new tab
    // there, and the ledger would record the conversation as having lived
    // in it. The resume must place the tab where it is told, in one step.
    const zeta = await callMcp(app, 'createGroup', { name: 'Zeta' })
    const zetaTab = await callMcp(app, 'openSession', { groupId: zeta.groupId, mode: 'terminal', cwd: ROOT, name: 'zeta shell' })
    await callMcp(app, 'focus', { sessionId: zetaTab.sessionId })
    await win.waitForTimeout(400)
    // And the target group's web view is on screen (every project group
    // here carries a board): the resume must reveal the terminal, not spawn
    // and place the conversation under the board.
    writeFileSync(path.join(ROOT, 'board.html'), '<!doctype html><title>board</title><p>board</p>')
    await callMcp(app, 'setGroupView', { groupId: liveGroupId, url: path.join(ROOT, 'board.html') })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    await win.click(`[data-sidebar-item-id="${liveGroupId}"] > button`, { button: 'right' })
    await win.waitForTimeout(350)
    await win.locator('.menu-surface .menu-item', { hasText: 'Show web view' }).click()
    await win.waitForTimeout(500)
    t.check("the group's web view covers the pane", await webViewCoversPane(win))
    await win.click(`[data-sidebar-item-id="${liveGroupId}"] > button`, { button: 'right' })
    await win.waitForTimeout(350)
    await win.locator('.menu-surface .menu-item', { hasText: 'History' }).click()
    await win.waitForSelector('[data-history-row="cc-alpha-2"]', { timeout: 5000 })
    const readSpawns = await spyPtySpawn(app)
    await win.click('[data-history-row="cc-alpha-2"]')
    await win.waitForTimeout(800)
    const spawns = await readSpawns()
    t.equal('clicking a row issues exactly one spawn', spawns.length, 1)
    t.equal('the spawn resumes the row\'s conversation', spawns[0]?.resumeSessionId, 'cc-alpha-2')
    t.check('as a Claude session, without skipping permissions', spawns[0]?.claudeMode === true && spawns[0]?.dangerousMode === false, spawns[0])
    t.equal("in the conversation's own cwd", spawns[0]?.cwd, ROOT)
    t.check('the dialog closed on the click', await win.evaluate(() => !document.querySelector('[data-history-dialog]')))
    // "Is the board still in the way?" is a HIT TEST, not a DOM query. Since
    // PRDCT-2122 a view that has been opened stays MOUNTED and is hidden with
    // `visibility` when something else takes the pane — so its page survives a
    // switch away instead of reloading — which means querySelector('iframe')
    // now answers "was one ever opened", not "is one covering the terminal".
    // What this assertion has always meant is the latter.
    t.check('and the resume revealed the terminal: the web view no longer covers the pane', !(await webViewCoversPane(win)))
    const placed = await until(async () => {
      const list = await callMcp(app, 'list', {})
      const s = list.sessions.find((x) => x.groupId === liveGroupId && x.name === 'Export button')
      return s ?? null
    })
    t.check('the resumed tab is placed in the selected group, named by its title', !!placed, placed)
    if (placed) {
      const stamped = await until(() => readLedger().find((r) => r.sessionId === placed.id && r.claudeSessionId === 'cc-alpha-2' && r.groupId === liveGroupId) ?? null)
      t.check('and the resume itself is a ledger row in that group', !!stamped)
      const rows = readLedger().filter((r) => r.sessionId === placed.id)
      t.check('and NO row ever claims it lived in the group that held the selection', !rows.some((r) => r.groupId === zeta.groupId), rows.map((r) => r.groupName))
    }

    // --- The gone row cannot resume ---
    await win.keyboard.press('Meta+Shift+H')
    await win.waitForSelector('[data-history-dialog]', { timeout: 5000 })
    t.equal('⌘⇧H opens on All', await win.evaluate(() => document.querySelector('[data-history-chip][data-selected="true"]')?.getAttribute('data-history-chip')), 'all')
    await win.waitForSelector('[data-history-row="cc-alpha-gone"]', { timeout: 5000 })
    await win.click('[data-history-row="cc-alpha-gone"]')
    await win.waitForTimeout(500)
    t.equal('a row whose transcript is gone spawns nothing', (await readSpawns()).length, 1)
    t.check('and leaves the dialog open', await win.evaluate(() => !!document.querySelector('[data-history-dialog]')))

    // --- Escape with a row's menu open dismisses the menu, not the dialog ---
    // `.menu-item` narrows to an actual MENU: the message trail floats a
    // `.menu-surface` over a live tab's terminal at all times, so the bare
    // class no longer means "a menu is open".
    await win.click('[data-history-row="cc-alpha-1"]', { button: 'right' })
    await win.waitForTimeout(350)
    t.check('the row menu opened above the dialog', await win.evaluate(() => !!document.querySelector('.menu-surface .menu-item')))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    t.check('Escape closed the menu', await win.evaluate(() => !document.querySelector('.menu-surface .menu-item')))
    t.check('and left the dialog open', await win.evaluate(() => !!document.querySelector('[data-history-dialog]')))

    // --- From All, a resume lands in the group the conversation last lived in ---
    await callMcp(app, 'focus', { sessionId: zetaTab.sessionId })
    await win.waitForTimeout(300)
    await win.click('[data-history-row="cc-alpha-1"]')
    await win.waitForTimeout(800)
    const spawnsAll = await readSpawns()
    t.equal('the row resumes its conversation', spawnsAll[1]?.resumeSessionId, 'cc-alpha-1')
    const placedAll = await until(async () => {
      const list = await callMcp(app, 'list', {})
      return list.sessions.find((x) => x.name === 'Login bug fix') ?? null
    })
    t.equal('and lands in the live group named like the one it lived in, not the ambient one', placedAll?.groupId, liveGroupId)
    if (placedAll) {
      const rows = await until(() => {
        const all = readLedger().filter((r) => r.sessionId === placedAll.id)
        return all.length > 0 ? all : null
      })
      t.check('its ledger rows name that group only', !!rows && rows.every((r) => r.groupId === liveGroupId), rows?.map((r) => r.groupName))
    }

    // --- The whole store IS the default universe, scoped by each conversation's own cwd ---
    await win.keyboard.press('Meta+Shift+H')
    await win.waitForSelector('[data-history-row]', { timeout: 5000 })
    const rowIds = () => win.evaluate(() => [...document.querySelectorAll('[data-history-row]')].map((el) => el.getAttribute('data-history-row')))
    await win.waitForSelector('[data-history-row="cc-outside"]', { timeout: 10000 })
    const allIds = await rowIds()
    t.check('the conversation Clave never ran is listed by default', allIds.includes('cc-outside'))
    t.check('but not one whose own cwd is another root', !allIds.includes('cc-foreign'), allIds)
    t.check('a cwd-less transcript is scoped by its store dir: ours listed, the foreign one not', allIds.includes('cc-nocwd') && !allIds.includes('cc-nocwd-foreign'), allIds)
    t.check("never the app's own tab-title helper calls", !allIds.includes('cc-titlegen'), allIds)
    t.check('the codex user thread is listed beside the claude ones', allIds.includes('cx-0001'), allIds)
    t.check('never a codex subagent thread, nor a foreign-root one', !allIds.includes('cx-sub') && !allIds.includes('cx-foreign'), allIds)
    t.check('a cwd-less codex thread is unlisted, never shown in every workspace', !allIds.includes('cx-nocwd'), allIds)
    t.equal('two rollouts with one thread id are ONE row', allIds.filter((id) => id === 'cx-0001').length, 1)
    t.equal('the codex row wears its provider', await win.evaluate(() => document.querySelector('[data-history-row="cx-0001"]')?.getAttribute('data-history-provider')), 'codex')
    t.equal('titled by its first human message', await win.evaluate(() => document.querySelector('[data-history-row="cx-0001"] .history-row-title')?.textContent), 'Sweep the codex garden please')
    const footerCounts = await win.evaluate(() => document.querySelector('[data-history-footer]')?.textContent ?? '')
    t.check('the footer counts by provider, literally', /^\d+ claude sessions · 1 codex ·/.test(footerCounts), footerCounts)
    const dupEntries = await win.evaluate(() =>
      window.electronAPI.historyList().then((r) => r.entries.filter((e) => e.claudeSessionId === 'cc-dup').length)
    )
    t.equal('one stem under two dirs is ONE entry from the service (not a React key collapse)', dupEntries, 1)
    t.equal('and the larger transcript is the one shown', await win.evaluate(() => document.querySelector('[data-history-row="cc-dup"] .history-row-title')?.textContent), 'Duplicated stem')
    t.equal('titled by its own ai-title', await win.evaluate(() => document.querySelector('[data-history-row="cc-outside"] .history-row-title')?.textContent), 'Outside conversation')
    t.check('every closed row wears the hollow dot', await win.evaluate(() => [...document.querySelectorAll('[data-history-row]:not([data-live])')].every((el) => el.getAttribute('data-state') === 'closed')))

    // --- Open: only conversations open as a tab right now ---
    await win.click('[data-history-open]')
    await win.waitForTimeout(300)
    const openRows = await win.evaluate(() => [...document.querySelectorAll('[data-history-row]')].map((el) => ({ id: el.getAttribute('data-history-row'), live: el.hasAttribute('data-live') })))
    t.check('the Open filter keeps only live rows', openRows.every((r) => r.live), openRows)
    t.check('and the closed store-only conversation is gone', !openRows.some((r) => r.id === 'cc-outside'))
    await win.click('[data-history-open]')
    await win.waitForTimeout(200)

    // --- Search reaches inside store-only and codex transcripts too ---
    await win.fill('[data-history-filter]', 'plain terminal')
    r = await searched()
    t.check('the transcript search finds a word inside a store-only conversation', (r?.hits ?? []).some((h) => h?.includes('plain terminal')), r?.hits)
    // A store update while the query is unchanged must not cancel the search.
    const cancelsBefore = (await app.evaluate(() => globalThis.__e2eCancels?.length ?? 0))
    await callMcp(app, 'rename', { target: 'session', id: tabId, name: 'renamed mid-search' })
    await callMcp(app, 'rename', { target: 'session', id: tabId, name: 'renamed again' })
    await win.waitForTimeout(700)
    const cancelsAfter = (await app.evaluate(() => globalThis.__e2eCancels?.length ?? 0))
    t.equal('an unrelated session-store update never cancels or restarts the search', cancelsAfter, cancelsBefore)
    await win.fill('[data-history-filter]', 'codex garden')
    r = await searched()
    t.check('and inside a codex rollout, through the same toggles', (r?.hits ?? []).some((h) => h?.includes('codex garden')), r?.hits)
    await win.fill('[data-history-filter]', '')

    // --- A codex row is inert: listed for the record, nothing spawns ---
    const codexBefore = (await readSpawns()).length
    await win.click('[data-history-row="cx-0001"]')
    await win.waitForTimeout(400)
    t.equal('clicking a codex row spawns nothing', (await readSpawns()).length, codexBefore)
    t.check('and leaves the dialog open', await win.evaluate(() => !!document.querySelector('[data-history-dialog]')))
    await win.click('[data-history-row="cx-0001"]', { button: 'right' })
    await win.waitForTimeout(350)
    const codexMenu = await win.evaluate(() =>
      [...document.querySelectorAll('.menu-surface .menu-item')].map((el) => [el.textContent?.trim(), el.getAttribute('data-disabled') !== null || el.getAttribute('aria-disabled') === 'true'])
    )
    t.check('its menu disables both Resume entries', codexMenu.filter(([l]) => l?.startsWith('Resume')).every(([, d]) => d), codexMenu)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)

    // --- A cwd-less row has nothing to resume ---
    const inertBefore = (await readSpawns()).length
    await win.click('[data-history-row="cc-nocwd"]')
    await win.waitForTimeout(400)
    t.equal('clicking a cwd-less row spawns nothing', (await readSpawns()).length, inertBefore)
    t.check('and leaves the dialog open', await win.evaluate(() => !!document.querySelector('[data-history-dialog]')))
    await win.click('[data-history-row="cc-nocwd"]', { button: 'right' })
    await win.waitForTimeout(350)
    const menuState = await win.evaluate(() =>
      [...document.querySelectorAll('.menu-surface .menu-item')].map((el) => [el.textContent?.trim(), el.getAttribute('data-disabled') !== null || el.getAttribute('aria-disabled') === 'true'])
    )
    t.check('its menu disables both Resume entries', menuState.filter(([l]) => l?.startsWith('Resume')).every(([, d]) => d), menuState)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)

    // --- A store-only conversation resumes like any other ---
    const spawnsBefore = (await readSpawns()).length
    await win.click('[data-history-row="cc-outside"]')
    await win.waitForTimeout(800)
    const outsideSpawn = (await readSpawns())[spawnsBefore]
    t.equal('clicking it resumes the outside conversation', outsideSpawn?.resumeSessionId, 'cc-outside')
    t.equal("in the conversation's own folder", outsideSpawn?.cwd, ROOT)

    await win.keyboard.press('Meta+Shift+H')
    await win.waitForSelector('[data-history-dialog]', { timeout: 5000 })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    t.check('Escape closes the dialog', await win.evaluate(() => !document.querySelector('[data-history-dialog]')))
  } finally {
    await app.close()
    killLeakedE2eTmux()
  }
}
