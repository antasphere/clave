/**
 * A group prompt edited in the `.clave` must reach the group (PRDCT-1665).
 *
 * The watcher's reload parsed the new prompt and then dropped it: `prompt` was
 * normalised but missing from both `updatePinnedGroup` calls it feeds. Every
 * other field reloaded, so you edited a lane's brief, watched the name change,
 * and the `+` went on dispatching agents on the old one. Nothing on screen was
 * wrong — the "demos perfectly and does nothing" shape.
 *
 * The group NAME is the control. A watcher that never fired, or fired too late,
 * fails both assertions and reads as infrastructure; only the prompt failing is
 * the regression. Without the control a flaky watcher looks like a prompt bug.
 *
 * What "reaches the group" means, precisely: a group already stamped out is a
 * SNAPSHOT — `spawnTemplate` is a stamp, its sessions and its brief are copied
 * at that moment and a later file edit does not reach back into a running group.
 * The reload's job is that the PIN carries the new brief, so the next group
 * stamped from it launches on what the file now says. That is what this asserts,
 * and it is the distinction the first version of this spec got wrong: it read
 * the name off the pin and the prompt off a group stamped before the edit, so it
 * compared two different things and blamed the code.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  spyPtySpawn,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('prompt-hot-reload')
const ROOT = fixturePath('hotreload-root')
const CLAVE = `${ROOT}/lane.clave`
const BEFORE = { name: 'Lane Before', prompt: 'HOTRELOAD-A the original brief' }
const AFTER = { name: 'Lane After', prompt: 'HOTRELOAD-B the edited brief' }
const WS = {
  id: 'ffffffff-0000-4000-8000-00000000000f',
  name: 'HotReload',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

function writeClave({ name, prompt }) {
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        name,
        cwd: '.',
        color: 'teal',
        prompt,
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
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeClave(BEFORE)
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    await win.click('button[aria-label="Add a group"]')
    await win.waitForTimeout(700)
    await win.click('.group-picker-card')
    await win.waitForTimeout(6000)

    // Edit BOTH fields on disk. The name is the control.
    writeClave(AFTER)
    await win.waitForTimeout(6000)

    const cards = await win.evaluate(async () => {
      document.querySelector('button[aria-label="Add a group"]')?.click()
      await new Promise((r) => setTimeout(r, 800))
      return [...document.querySelectorAll('.group-picker-card')].map((c) =>
        (c.textContent || '').trim()
      )
    })
    t.check(
      'CONTROL: the edited group NAME reached the pin',
      cards.some((c) => c.includes(AFTER.name)),
      cards
    )

    // Stamp a fresh group from the reloaded pin — the picker is already open.
    const readSpawns = await spyPtySpawn(app)
    await win.click('.group-picker-card')
    await win.waitForTimeout(6000)

    // Its `+` must launch on the brief the file now says. Addressed BY NAME:
    // the `+` sits in the card's HEADER — a SIBLING of .group-rail, not a
    // descendant, since the "New session" row at the foot of the card became
    // the header's `+` — and its aria-label carries the group's name, which is
    // the only handle that survives the card moving. It does move: a freshly
    // stamped group is now the FIRST card in the list, not the last, so
    // `.last()` here clicked the stale group's `+` and the check failed on the
    // old brief while the reload had worked perfectly.
    await win.locator(`[aria-label^="New session in ${AFTER.name}"]`).first().click()
    await win.waitForTimeout(4000)

    const prompts = (await readSpawns()).map((x) => x.initialPrompt).filter(Boolean)
    t.check(
      'the edited PROMPT reached the pin, so a freshly stamped group launches on it',
      prompts.some((x) => x.includes(AFTER.prompt)),
      prompts
    )
    t.check(
      'and no launch carried the stale brief',
      !prompts.some((x) => x.includes(BEFORE.prompt)),
      prompts
    )
  } finally {
    await app.close()
  }
}
