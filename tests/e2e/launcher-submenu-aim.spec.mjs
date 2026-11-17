/**
 * The launcher's submenus follow the row the pointer moves to, and its Skip
 * permissions switch makes the model picked next start without prompts
 * (PRDCT-4659).
 *
 * Radix keeps an open submenu while the pointer heads for it: for 300 ms
 * after the pointer leaves the submenu's trigger, every other row inside a
 * triangle from the exit point to the whole submenu is ignored. Claude Code's
 * Model panel is several rows tall, so that triangle covers the Codex row
 * under it: a pointer moved onto Codex and on toward the panel still landed in
 * Claude's models, and a pointer that stopped on Codex never opened Codex's.
 * The aim rule (`packages/ui/src/lib/submenu-aim.ts`) lets a row take over
 * unless the pointer is heading into the open submenu, and after 100 ms on the
 * row whatever its heading. These checks drive the real pointer along the
 * paths a person takes and read which submenu is open; the rest and the
 * along-the-row paths were red before the rule, and the quick crossing proves
 * the submenu a pointer heads for is still kept.
 */
import {
  until,
  launchApp,
  seedWorkspaces,
  userDataDir,
  fixturePath,
  markHarnessesInstalled,
  terminalJournalPath
} from './harness.mjs'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const DIR = userDataDir('launcher-submenu-aim')
const ROOT = fixturePath('launcher-submenu-aim-root')
const WS = {
  id: 'cccccccc-0000-4000-8000-00000000000c',
  name: 'Aim',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** The terminal journal's lines so far: every spawn and write of the run. */
const journal = () =>
  existsSync(terminalJournalPath(DIR))
    ? readFileSync(terminalJournalPath(DIR), 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
    : []

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })

  const { app, win } = await launchApp(DIR)
  try {
    const openCaret = async () => {
      for (let i = 0; i < 10; i++) {
        // Never toggle a menu that is still open or fading out.
        await win.keyboard.press('Escape')
        await until(async () => (await win.locator('[role="menu"]').count()) === 0, {
          tries: 30,
          gapMs: 100
        })
        await win.locator('.launcher-caret:not([disabled])').waitFor()
        await win.click('.launcher-caret')
        await markHarnessesInstalled(win)
        const shown = await win
          .locator('[data-harness-row="codex"]')
          .waitFor({ timeout: 1_500 })
          .then(
            () => true,
            () => false
          )
        if (shown && (await win.locator('.launcher-caret').getAttribute('data-state')) === 'open')
          return
      }
      throw new Error('the caret menu never opened')
    }
    const state = (id) => win.locator(`[data-harness-row="${id}"]`).getAttribute('data-state')
    const states = async () => ({ claude: await state('claude'), codex: await state('codex') })
    const boxOf = (selector) => win.locator(selector).first().boundingBox()
    /** The pointer from `from` to `to` in `steps` moves, `gapMs` apart. */
    const glide = async (from, to, steps, gapMs) => {
      for (let i = 1; i <= steps; i++) {
        await win.mouse.move(
          from.x + ((to.x - from.x) * i) / steps,
          from.y + ((to.y - from.y) * i) / steps
        )
        if (gapMs > 0) await win.waitForTimeout(gapMs)
      }
    }
    /** The menu open, the pointer resting on Claude Code at `at` of its width,
     *  its Model panel standing beside it. */
    const onClaude = async (at) => {
      await openCaret()
      const claude = await boxOf('[data-harness-row="claude"]')
      const y = claude.y + claude.height / 2
      await win.mouse.move(claude.x + 8, y)
      const point = { x: claude.x + claude.width * at, y }
      await glide({ x: claude.x + 8, y }, point, 4, 10)
      await until(async () => (await state('claude')) === 'open', { tries: 40, gapMs: 50 })
      const codex = await boxOf('[data-harness-row="codex"]')
      const panel = await win.locator('[role="menu"]').nth(1).boundingBox()
      return { point, claude, codex, panel }
    }
    const settled = async (want) =>
      until(
        async () => {
          const now = await states()
          return now.claude === want.claude && now.codex === want.codex ? now : null
        },
        { tries: 12, gapMs: 50 }
      )

    // ── A move down onto Codex: Codex's models, at once ──
    {
      const { point, codex } = await onClaude(0.5)
      await glide(point, { x: point.x + 2, y: codex.y + codex.height / 2 }, 6, 8)
      const now = await settled({ claude: 'closed', codex: 'open' })
      t.check('a move down onto the next row opens its submenu', !!now, await states())
    }

    // ── Heading for Claude's panel, stopping on Codex: Codex takes over ──
    {
      const { point, codex, panel } = await onClaude(0.5)
      const stop = { x: codex.x + codex.width * 0.8, y: codex.y + codex.height / 2 }
      // The line from the start through the stop meets the panel's near edge.
      const slope = (stop.y - point.y) / (stop.x - point.x)
      const meets = stop.y + slope * (panel.x - stop.x)
      t.check(
        'the stopping path heads into the open panel (the case Radix kept it for)',
        meets > panel.y && meets < panel.y + panel.height,
        { meets, panel }
      )
      await glide(point, stop, 5, 8)
      await win.waitForTimeout(250)
      const now = await settled({ claude: 'closed', codex: 'open' })
      t.check('a row the pointer stops on takes over from the open submenu', !!now, await states())
    }

    // ── Onto Codex at a slant, then along it into the panel: Codex's panel ──
    {
      const { claude, codex, panel } = await onClaude(0.3)
      const start = { x: claude.x + claude.width * 0.3, y: claude.y + claude.height / 2 }
      const onto = { x: codex.x + codex.width * 0.45, y: codex.y + codex.height / 2 }
      await glide(start, onto, 4, 10)
      // Along the row at a person's pace, past its end and into the panel.
      const into = { x: panel.x + 40, y: onto.y }
      await glide(onto, into, 16, 12)
      const now = await settled({ claude: 'closed', codex: 'open' })
      t.check(
        'a row the pointer moves onto and along takes over before the pointer reaches the panel',
        !!now,
        await states()
      )
    }

    // ── Crossing Codex quickly toward a lower entry of Claude's panel ──
    {
      const { point, panel } = await onClaude(0.5)
      const target = { x: panel.x + 30, y: panel.y + panel.height * 0.6 }
      await glide(point, target, 8, 0)
      await win.waitForTimeout(250)
      t.check(
        'a quick crossing on the way into the open submenu keeps it open',
        (await state('claude')) === 'open' && (await state('codex')) === 'closed',
        await states()
      )
    }

    // ── Skip permissions: a switch, then the model picked next skips the prompts ──
    {
      await onClaude(0.5)
      const models = win.locator('[role="menu"]').nth(1)
      const toggle = models.locator('[data-harness-skip-permissions="claude"]')
      await toggle.waitFor()
      t.equal('the switch starts off', await toggle.getAttribute('aria-checked'), 'false')
      await toggle.click()
      t.equal('a click turns it on', await toggle.getAttribute('aria-checked'), 'true')
      t.check(
        'and leaves the models open, to pick one',
        (await win.locator('[role="menu"]').count()) >= 2,
        await win.locator('[role="menu"]').count()
      )
      t.check(
        'the Claude Code row says its launches skip the prompts',
        (await win.locator('[data-harness-skips-permissions="claude"]').count()) === 1
      )
      // A model other than the default, so the pick is visibly the one launched.
      const model = models
        .locator('[data-harness-model]:not([data-harness-model="default"])')
        .first()
      const picked = await model.getAttribute('data-harness-model')
      const before = journal().length
      await model.click()
      const spawned = await until(
        () =>
          journal()
            .slice(before)
            .find((line) => line.kind === 'spawn' && line.options?.claudeMode) ?? null
      )
      t.check('picking a model starts a Claude tab', !!spawned, spawned?.options)
      t.equal('on the model picked', spawned?.options?.model, picked)
      t.equal('with its permission prompts skipped', spawned?.options?.dangerousMode, true)
    }
  } finally {
    await app.close()
  }
}
