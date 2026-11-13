// Runs in BOTH modes (wave 5, lane B, PRDCT-3432). The records this spec relies
// on are read and written where the launch's terminal manager keeps them (the
// app's folder in-process, the server's attached), and the attached restore now
// reattaches a live agent session the way the in-process boot does. Wave 4
// pinned it for the records seeded into the app's folder.
/**
 * Launch profiles and Pi are wired through the real settings UI, preload IPC,
 * main-process persistence, launcher, and keyboard shortcut.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  agentButtonLabel,
  callMcp,
  killLeakedE2eTmux,
  launchApp,
  markHarnessesInstalled,
  seedWorkspaces,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('agent-launch-profiles')
const ROOT = fixturePath('agent-launch-profiles-root')
const PI_ROOT = fixturePath('agent-launch-profiles-pi')
const USER_SHELL = `${ROOT}/fake-user-shell.sh`
const RECORDER = `${ROOT}/fake-codex.sh`
const RECORDED = `${ROOT}/fake-codex.argv`
const WORKSPACE = {
  id: 'aaaaaaaa-0000-4000-8000-00000000000c',
  name: 'Profiles',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  // Nushell and Fish cannot parse the POSIX command wrapper Clave uses for
  // agent launches. This stand-in (a name off the POSIX allowlist, like theirs)
  // still supports Clave's environment probe and plain interactive terminals,
  // but fails if Clave asks it to parse a command.
  writeFileSync(
    USER_SHELL,
    [
      '#!/bin/sh',
      'if [ "$1" = "-lic" ]; then exec /bin/zsh "$@"; fi',
      'if [ "$1" = "-l" ] && [ "$#" -eq 1 ]; then exec /bin/zsh -l; fi',
      'echo "user shell cannot parse POSIX agent commands" >&2',
      'exit 91',
      ''
    ].join('\n')
  )
  chmodSync(USER_SHELL, 0o755)
  // A profile is only real if its command is what actually runs. This stands in
  // for the agent binary and writes the argv it was handed, one token per line,
  // so the assertion is on the spawned process rather than on the stored JSON.
  writeFileSync(
    RECORDER,
    [
      '#!/bin/sh',
      `: > ${RECORDED}`,
      `for a in "$@"; do echo "$a" >> ${RECORDED}; done`,
      'sleep 60',
      ''
    ].join('\n')
  )
  chmodSync(RECORDER, 0o755)
  // A leftover recording from an earlier run would make the argv assertion
  // pass without the profile ever being resolved. Start from nothing.
  rmSync(RECORDED, { force: true })
  seedWorkspaces(DIR, {
    workspaces: [WORKSPACE],
    activeWorkspaceId: WORKSPACE.id,
    fresh: true
  })

  const launchEnv = {
    CLAVE_PI_ROOT: PI_ROOT,
    SHELL: USER_SHELL,
    // Pi's own test-only override keeps the real ~/.pi session store untouched.
    PI_CODING_AGENT_SESSION_DIR: PI_ROOT
  }
  let { app, win } = await launchApp(DIR, { env: launchEnv })
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'agents')
    })
    await win.waitForSelector('h2:has-text("Harnesses")', { timeout: 10_000 })

    // Settings → Harnesses (PRDCT-4424): one block per harness, each with its
    // launch profiles in a closed Advanced fold.
    const harnessIds = await win
      .locator('section[data-harness]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-harness')))
    t.equal(
      'settings exposes all five harnesses as first-class sections',
      harnessIds.join(','),
      'claude,codex,antigravity,pi,opencode'
    )

    const piSection = win.locator('section[data-harness="pi"]')
    const piFold = piSection.locator('[data-harness-advanced="pi"]')
    t.equal('the launch profiles start folded', await piFold.getAttribute('aria-expanded'), 'false')
    await piFold.click()
    await piSection.getByRole('button', { name: 'Add profile' }).click()
    const editor = piSection.locator('.settings-card').last()
    const inputs = editor.locator('input')
    await inputs.nth(0).fill('Pi production')
    await inputs.nth(2).fill('anthropic')
    await inputs.nth(3).fill('claude-sonnet-4')
    // The select is the app's own (a menu on a trigger), not a native <select>.
    // The option is picked by typeahead: with five harnesses on the page the
    // Pi editor sits low, and in this window the open menu can run past the
    // viewport, where a pointer click never lands (PRDCT-4424).
    await editor.locator('[data-settings-select="pi-thinking"]').click()
    const high = win.getByRole('menuitem', { name: 'high', exact: true })
    await high.waitFor()
    await high.focus()
    await high.press('Enter')
    await editor.getByRole('button', { name: 'Save profile' }).click()

    const preferences = await win.evaluate(() => window.electronAPI.launchProfilesList())
    const profile = preferences.customProfiles.find(
      (candidate) => candidate.name === 'Pi production'
    )
    t.check(
      'saving the Pi profile crossed renderer IPC and reached main persistence',
      !!profile,
      preferences
    )
    t.equal('the provider is stored as a Pi profile default', profile?.pi?.provider, 'anthropic')
    t.equal('the model is stored as a Pi profile default', profile?.pi?.model, 'claude-sonnet-4')
    t.equal('the thinking level is stored as a Pi profile default', profile?.pi?.thinking, 'high')

    if (profile) {
      await piSection.locator('[data-settings-select="workspace-pi"]').click()
      await win.getByRole('menuitem', { name: 'Pi production', exact: true }).click()
      const updated = await win.evaluate(() => window.electronAPI.launchProfilesList())
      t.equal(
        'the workspace override is persisted independently from the global default',
        updated.workspaceOverrides[WORKSPACE.id]?.pi,
        profile.id
      )
    }

    await win.getByRole('button', { name: 'Back to sessions' }).click()
    await win.keyboard.press('Meta+Shift+P')
    await win.waitForTimeout(2500)
    t.equal('Cmd+Shift+P launches and remembers Pi', await agentButtonLabel(win), 'Pi')

    await win.click('.launcher-caret')
    await markHarnessesInstalled(win)
    const rowNames = await win
      .locator('[data-harness-row]')
      .evaluateAll((els) =>
        els.map((el) => [
          el.getAttribute('data-harness-row'),
          el.querySelector('span.flex-1')?.textContent?.trim()
        ])
      )
    t.equal(
      'the launcher lists each harness by its name, Pi, Codex and OpenCode included',
      JSON.stringify(rowNames),
      JSON.stringify([
        ['claude', 'Claude Code'],
        ['codex', 'Codex'],
        ['antigravity', 'Antigravity'],
        ['pi', 'Pi'],
        ['opencode', 'OpenCode']
      ])
    )
    const menuText = (await win.locator('[role="menu"]').allTextContents()).join(' ')
    t.check(
      'no row is a permission flag: the dangerous launch is the shortcut (Cmd+Y below)',
      !/YOLO|skip permissions/.test(menuText),
      menuText
    )
    if (profile) {
      await win.locator('[data-harness-row="pi"]').hover()
      const piModel = win.locator('[data-harness-model="claude-sonnet-4"]')
      t.check(
        'hovering Pi offers the model its saved profile pins',
        await piModel.waitFor({ timeout: 5_000 }).then(
          () => true,
          () => false
        )
      )
      await win.locator(`[role="menu"] [data-harness-advanced="pi"]`).hover()
      const entry = win.locator(`[data-launch-profile-entry="${profile.id}"]`)
      t.check(
        'and its saved launch profile under Advanced',
        await entry.waitFor({ timeout: 5_000 }).then(
          () => true,
          () => false
        )
      )
    }
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')

    // ── The profile's command is what runs ──────────────────────────────────
    // Everything above proves the settings round-trip. This proves the point of
    // the feature: a wrapper command set as a workspace default reaches the
    // shell through the ordinary launch path, one token per argument.
    const wrapper = await win.evaluate(
      async ({ recorder, workspaceId }) => {
        const saved = await window.electronAPI.launchProfileUpsert({
          id: 'e2e-codex-wrapper',
          name: 'Codex wrapper',
          family: 'codex',
          command: [recorder, 'run', '--'],
          additionalArgs: ['--flag', 'a value with spaces']
        })
        await window.electronAPI.launchProfileSetWorkspace(
          workspaceId,
          'codex',
          'e2e-codex-wrapper'
        )
        return saved.customProfiles.find((p) => p.id === 'e2e-codex-wrapper') ?? null
      },
      { recorder: RECORDER, workspaceId: WORKSPACE.id }
    )
    t.check('an argument-vector profile with a wrapper is accepted', !!wrapper, wrapper)

    // ⌘U is the ordinary Codex launch — no profile named at the call site, so
    // the workspace default is what has to be found at the spawn boundary.
    // The shortcut follows the interaction mode like every road (PRDCT-4425):
    // Terminal here, so the argv of the wrapper is what is proven.
    await win.evaluate(() => window.electronAPI.launchSettingsSet({ interactionMode: 'terminal' }))
    await win.keyboard.press('Meta+u')
    const argv = await until(
      () =>
        existsSync(RECORDED) ? readFileSync(RECORDED, 'utf-8').split('\n').filter(Boolean) : null,
      { tries: 40, gapMs: 250 }
    ).catch(() => null)
    const terminalText = argv
      ? null
      : await win
          .locator('.xterm-rows')
          .last()
          .textContent()
          .catch(() => null)
    t.check('the profile command was the process Clave spawned', argv !== null, {
      argv,
      terminalText
    })
    if (argv) {
      t.equal(
        'every profile token arrived as its own argument, spaces intact',
        argv.join('|'),
        'run|--|--flag|a value with spaces'
      )
    }

    // Cmd+Y reuses that same Codex profile but must add the Clave-owned YOLO
    // flag after the profile's tokens. The fake binary makes this an assertion
    // on the process actually spawned, rather than on the renderer's intent.
    rmSync(RECORDED, { force: true })
    await win.keyboard.press('Meta+y')
    const yoloArgv = await until(
      () =>
        existsSync(RECORDED) ? readFileSync(RECORDED, 'utf-8').split('\n').filter(Boolean) : null,
      { tries: 40, gapMs: 250 }
    ).catch(() => null)
    t.check('Cmd+Y launches the Codex profile in YOLO mode', yoloArgv !== null, yoloArgv)
    if (yoloArgv) {
      t.equal(
        'the spawned Codex command receives --yolo after profile arguments',
        yoloArgv.join('|'),
        'run|--|--flag|a value with spaces|--yolo'
      )
    }

    const beforeRestart = await callMcp(app, 'list', {})
    const launchedSession = beforeRestart.sessions.find((session) => session.mode === 'codex')
    t.check('the cross-shell agent is alive before restart', launchedSession?.alive === true, {
      launchedSession,
      sessions: beforeRestart.sessions
    })

    await app.close()
    app = null
    const relaunched = await launchApp(DIR, {
      env: launchEnv,
      settleMs: 6000
    })
    app = relaunched.app
    win = relaunched.win

    const restoredSession = launchedSession
      ? await until(async () => {
          const list = await callMcp(app, 'list', {})
          return list.sessions.find(
            (session) => session.id === launchedSession.id && session.alive === true
          )
        })
      : null
    t.check(
      'the same cross-shell agent session reattaches after restart',
      !!launchedSession && restoredSession?.id === launchedSession.id,
      { launchedSession, restoredSession }
    )
  } finally {
    if (app) await app.close()
    killLeakedE2eTmux()
  }
}
