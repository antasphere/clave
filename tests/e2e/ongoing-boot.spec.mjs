/**
 * Ongoing conversations (PRDCT-4190): the boot keeps offering a dead WORK tab back while it keeps an ongoing one out of the prompt, and the entry follows the tab its resume opened (verifier round 1, suite gaps M1d and M6c).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until
} from './harness.mjs'

const DIR = userDataDir('ongoing-boot')
const ROOT = fixturePath('ongoing-boot-root')
// The stub speaks at its first start, as a real tab would before it is moved: its
// transcript is what a resume needs (PRDCT-4208, F7: none means a fresh start).
const TRANSCRIPTS = `${ROOT}/transcripts`
const SPOKEN = `${TRANSCRIPTS}/stub`
const TRANSCRIPTS_ENV = { CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS }
const BIN = `${ROOT}/bin`
const STARTS = `${ROOT}/agent-starts.jsonl`
const WS = {
  id: 'ongoing-boot-ws-0000-4000-8000-00000000000e',
  name: 'ProbeBoot',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const rowSel = (id) => `[data-sidebar-item-id="${id}"]`
const SHELF = '[data-ongoing-shelf]'
const PAGE = '[data-ongoing-page]'
const starts = () =>
  existsSync(STARTS)
    ? readFileSync(STARTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []

export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${BIN}/claude`,
    `#!/bin/sh\nargs=$(printf '%s' "$*" | tr -d '"\\\\' | cut -c1-200)\necho '{"session":"'"$CLAVE_SESSION_ID"'","args":"'"$args"'"}' >> ${JSON.stringify(STARTS)}\nsid=''; prev=''; for a in "$@"; do [ "$prev" = '--session-id' ] && sid="$a"; prev="$a"; done\n[ -n "$sid" ] && mkdir -p ${JSON.stringify(SPOKEN)} && echo '{"type":"user","message":{"content":"hello"}}' > ${JSON.stringify(SPOKEN)}/"$sid".jsonl\nexec sleep 600\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(DIR, 'agent-launch-profiles.json'),
    JSON.stringify({
      version: 1,
      customProfiles: [
        {
          id: 'stub-claude',
          name: 'Stub Claude',
          family: 'claude',
          command: [`${BIN}/claude`],
          additionalArgs: []
        }
      ],
      globalDefaults: {},
      workspaceOverrides: {}
    })
  )
  let { app, win } = await launchApp(DIR, { env: TRANSCRIPTS_ENV })
  const tmux = []
  try {
    const a = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Acc'
    })
    const b = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'claude',
      profile: 'stub-claude',
      name: 'Work'
    })
    await until(
      async () =>
        (await win.evaluate((s) => !!document.querySelector(s), rowSel(a.sessionId))) &&
        (await win.evaluate((s) => !!document.querySelector(s), rowSel(b.sessionId)))
    )
    for (const id of [a.sessionId, b.sessionId]) {
      const r = await win.evaluate(
        async (i) =>
          (await window.electronAPI.listSessionRecords({ ids: [i] })).find((s) => s.id === i),
        id
      )
      if (r?.tmuxName) tmux.push(r.tmuxName)
    }
    await win.click(`${rowSel(a.sessionId)} .sidebar-item`, { button: 'right' })
    await win.waitForTimeout(300)
    await win.getByRole('menuitem', { name: 'Move to Ongoing' }).click()
    await win.waitForTimeout(1200)
    await app.close()
    app = null
    await new Promise((r) => setTimeout(r, 1500))
    for (const n of tmux) {
      try {
        execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${n}`], { timeout: 10_000 })
      } catch {
        // the tmux session may already be gone
      }
    }
    const second = await launchApp(DIR, {
      env: TRANSCRIPTS_ENV,
      settleMs: 0,
      bootTimeoutMs: 20_000
    }).catch((e) => ({
      err: String(e)
    }))
    if (second.err) {
      // waitForBoot may stop at the prompt: read the mark from a fresh handle
      t.check('[info] launch returned an error', false, second.err)
      return
    }
    app = second.app
    win = second.win
    // The prompt comes during the boot inside the app, and after it, from
    // the server's top-up, when the server runs apart: wait for it either way.
    const boot = await until(
      () =>
        win.evaluate(() =>
          document.documentElement.dataset.boot === 'restore-prompt' ? 'restore-prompt' : null
        ),
      { tries: 80, gapMs: 250 }
    )
    const records = await win.evaluate(
      async (id) => (await window.electronAPI.listSessionRecords({ ids: [id] })).map((r) => r.id),
      b.sessionId
    )
    t.check(
      'B1 the non-ongoing dead work tab is still offered back in the restore prompt',
      boot === 'restore-prompt',
      { boot, records, work: b.sessionId }
    )
    if (boot === 'restore-prompt') {
      const dialogText = await win.evaluate(() => document.body.innerText.slice(0, 2000))
      t.check(
        'B1b the prompt counts one agent session (the work tab only)',
        /\b1 agent session\b/.test(dialogText),
        dialogText.slice(0, 300)
      )
      // decline so the boot completes
      const no = win.getByRole('button', { name: 'Start fresh' })
      await no.click().catch(() => {})
      await until(() => win.evaluate(() => document.documentElement.dataset.boot === 'complete'))
    }
    await until(async () => !!(await win.$(SHELF)))
    await win.click(SHELF)
    await win.waitForSelector(PAGE)
    const before = starts().length
    await win.click('[data-ongoing-card]')
    const resumed = await until(
      () =>
        starts()
          .slice(before)
          .find((x) => x.args.includes('--resume')) ?? null
    )
    await win.waitForTimeout(800)
    const saved = await win.evaluate(
      async () => await window.electronAPI.preferencesGet('ongoingConversations')
    )
    t.check(
      'B2 the entry is re-pointed at the resumed tab',
      Array.isArray(saved) && saved[0]?.sessionId === resumed?.session,
      { saved: saved?.[0]?.sessionId, resumed: resumed?.session }
    )
  } finally {
    if (app) await app.close()
  }
}
