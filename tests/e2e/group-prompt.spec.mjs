/**
 * The group's default prompt actually reaching the agent (PRDCT-1665).
 *
 * This asserts on the PAYLOAD CROSSING INTO THE MAIN PROCESS, not on the UI. The
 * prompt was silently dropped twice on the `.clave` import path while every
 * screen still looked right — a group card showing "prompt" and a `+` promising
 * it prove only that the renderer holds a string, never that anything was handed
 * on.
 *
 * The control is the `+` in the group's HEADER. It used to be a "New session"
 * row at the foot of the card and moved into the header when the header's
 * terminals became one button; its title, its aria-label and its handler came
 * with it unchanged. Only the selector moved — which is what this spec caught,
 * three commits later, by failing on a row that no longer existed.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  spyPtySpawn
} from './harness.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('group-prompt')
const ROOT = '/tmp/clave-e2e-group-root'
const CLAVE = `${ROOT}/lane.clave`
const MARKER = 'e2e-group-brief-marker'
const WS = {
  id: 'cccccccc-0000-4000-8000-00000000000c',
  name: 'Lanes',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

// A family becomes a submenu when chat/custom profiles are registered.
// Follow the built-in leaf so the assertions still exercise the terminal CLI.
async function selectBuiltIn(win, label, profileName, family) {
  const profiles = await win.evaluate(() => window.electronAPI.launchProfilesList())
  // One terminal built-in always exists; registered chat profiles add a second.
  const count = 1 + profiles.customProfiles.filter((p) => p.family === family).length
  const entry = win
    .locator('[role="menuitem"]')
    .filter({ has: win.getByText(label, { exact: true }) })
  const submenu = (await entry.getAttribute('aria-haspopup')) === 'menu'
  assert.equal(
    submenu,
    count > 1,
    `${label}: ${count} profiles must produce ${count > 1 ? 'a submenu' : 'a flat item'}`
  )
  await entry.click()
  if (count > 1) await win.getByRole('menuitem', { name: profileName, exact: true }).click()
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        name: 'Lane Alpha',
        cwd: '.',
        color: 'teal',
        category: 'Lanes',
        prompt: `${MARKER} at @root_path`,
        sessions: [
          {
            cwd: '.',
            name: 'seed',
            claudeMode: false,
            antigravityMode: false,
            codexMode: false,
            dangerousMode: false
          }
        ],
        terminals: []
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    // The parser must carry the group-level prompt off disk at all.
    const read = await win.evaluate(async (p) => {
      const r = await window.electronAPI.readClaveFile(p, p.replace(/\/[^/]+$/, ''))
      return { type: r?.type ?? null, prompt: r?.prompt ?? null }
    }, CLAVE)
    t.equal('the .clave parser reads the group prompt', read.prompt, `${MARKER} at @root_path`)

    // Remember Codex, so the group `+` launches an agent that takes a prompt
    // AND puts it on a command line this spec can read.
    await win.click('.launcher-caret')
    await win.waitForTimeout(800)
    await selectBuiltIn(win, 'Codex CLI', 'Codex', 'codex')
    await win.waitForTimeout(4000)

    // Add the group through the picker.
    await win.click('button[aria-label="Add a group"]')
    await win.waitForTimeout(700)
    const picker = await win.evaluate(() => {
      const panel = document.querySelector('.group-picker-panel')
      return panel
        ? {
            search: !!panel.querySelector('input'),
            cards: panel.querySelectorAll('.group-picker-card').length
          }
        : null
    })
    t.check('the group picker opens with a search field', picker?.search === true, picker)
    t.equal('and lists the group as a card', picker?.cards, 1)
    await win.click('.group-picker-card')
    await win.waitForTimeout(5000)
    t.check(
      'picking closes the picker',
      await win.evaluate(() => !document.querySelector('.group-picker-panel'))
    )

    // The group's `+`, in its header.
    const addBtn = await win.evaluate(
      () => document.querySelector('.group-new-session')?.title ?? null
    )
    t.check(
      'the + promises the group prompt',
      /starts on the group's prompt/.test(addBtn ?? ''),
      addBtn
    )
    const readSpawns = await spyPtySpawn(app)
    const before = await win.evaluate(
      () => document.querySelectorAll('[class*="sidebar-item"]').length
    )
    await win.click('.group-new-session')
    await win.waitForTimeout(4000)
    const after = await win.evaluate(
      () => document.querySelectorAll('[class*="sidebar-item"]').length
    )
    t.equal('the + launches one session', after, before + 1)
    t.check(
      'and puts it inside the group',
      await win.evaluate(() => (document.querySelector('.group-rail')?.children.length ?? 0) >= 3),
      await win.evaluate(() => document.querySelector('.group-rail')?.children.length ?? 0)
    )

    const spawns = await readSpawns()
    t.equal('and issues exactly one spawn', spawns.length, 1)
    const sent = spawns[0] ?? {}
    t.equal('into the group’s own directory', sent.cwd, ROOT)
    t.equal('under the workspace’s remembered agent', sent.codexMode, true)
    t.check(
      'carrying the group’s brief',
      typeof sent.initialPrompt === 'string' && sent.initialPrompt.includes(MARKER),
      sent.initialPrompt
    )
    t.check(
      'with @root_path expanded to the workspace root',
      (sent.initialPrompt ?? '').includes(ROOT),
      sent.initialPrompt
    )
    t.check(
      'and no raw token left behind',
      !(sent.initialPrompt ?? '').includes('@root_path'),
      sent.initialPrompt
    )
    // ── the `+` must never promise what the launch will drop ──
    // `claude agents` is spawned bare and refuses a positional prompt. The
    // control's wording and the spawn both have to come from ONE answer; when
    // they each carried their own, the `+` promised a brief that silently never
    // arrived.
    await win.click('.launcher-caret')
    await win.waitForTimeout(800)
    await selectBuiltIn(win, 'Claude Agents', 'Claude', 'claude')
    await win.waitForTimeout(4000)

    const agentsTooltip = await win.evaluate(
      () => document.querySelector('.group-new-session')?.title ?? null
    )
    t.check(
      'with Claude Agents remembered, the + stops promising the prompt',
      /can't take the group's prompt/.test(agentsTooltip ?? ''),
      agentsTooltip
    )

    const spawnsBefore = (await readSpawns()).length
    await win.click('.group-new-session')
    await win.waitForTimeout(4000)
    const agentsSpawn = (await readSpawns())[spawnsBefore] ?? {}
    t.equal('and the launch really is Claude Agents', agentsSpawn.claudeAgentsMode, true)
    t.equal('carrying no prompt, exactly as the + said', agentsSpawn.initialPrompt, null)
  } finally {
    await app.close()
  }
}
