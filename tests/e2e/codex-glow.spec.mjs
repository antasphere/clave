import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

const DIR = userDataDir('codex-glow')
const ROOT = fixturePath('codex-glow-root')
const SCRIPT = `${ROOT}/titles.py`
const ARGS = `${ROOT}/argv.json`
const WS = { id: 'glow-workspace', name: 'Glow', rootDir: ROOT, profileFile: null, createdAt: 1 }

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  // Real PTY output, including split OSC sequences, without starting a model.
  writeFileSync(
    SCRIPT,
    `import sys, json, time
json.dump(sys.argv[1:], open(${JSON.stringify(ARGS)}, 'w'))
def title(value):
    sys.stdout.write('\\x1b]0;' + value + '\\x07'); sys.stdout.flush()
title('codex | Ready')
for line in sys.stdin:
    value = line.strip()
    if value == 'exit': break
    if value == 'body':
        print('codex | Working', flush=True); continue
    if value == 'fragment':
        sys.stdout.write('\\x1b]0;codex | Thi'); sys.stdout.flush(); time.sleep(.1)
        sys.stdout.write('nking ⠋\\x1b\\\\'); sys.stdout.flush(); continue
    title(value)
`
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR)
  try {
    await win.evaluate(async (script) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'glow-codex',
        name: 'Glow Codex',
        family: 'codex',
        command: ['/usr/bin/python3', script],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetGlobal('codex', 'glow-codex')
    }, SCRIPT)
    for (const tmux of [false, true]) {
      const label = tmux ? 'tmux' : 'plain PTY'
      await win.evaluate((enabled) => window.electronAPI.preferencesSet('tmuxMode', enabled), tmux)
      const session = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'codex',
        name: `Codex ${label}`
      })
      const id = session.sessionId
      const row = win.locator('.sidebar-item').filter({ hasText: `Codex ${label}` })
      const icon = row.locator('.sidebar-tab-icon')
      await icon.waitFor()
      await until(async () => {
        const state = await callMcp(app, 'list', {})
        return state.sessions.find((s) => s.id === id)?.agentState === 'idle'
      })
      const send = (value) =>
        win.evaluate(({ id, value }) => window.electronAPI.writeSession(id, value + '\r'), {
          id,
          value
        })
      const blue = () => icon.locator('svg.text-status-working').count()
      const expectBlue = async (name, expected) => {
        const matched = await until(async () => (await blue()) === expected)
        t.check(`${label}: ${name}`, matched === true, await icon.innerHTML())
        if (!matched) throw new Error(`${label}: ${name}`)
      }
      t.equal(`${label}: idle icon is neutral`, await blue(), 0)
      await send('body')
      await win.waitForTimeout(250)
      t.equal(`${label}: body text does not pretend to be lifecycle state`, await blue(), 0)
      for (const status of ['codex | Working ⠋', 'codex | Waiting', 'fragment']) {
        await send(status)
        await expectBlue(`${status} lights the icon`, 1)
      }
      t.check(
        `${label}: blue icon uses Claude’s pulse`,
        (await icon.getAttribute('style')).includes('pulse-dot')
      )
      await send('[ ! ] Action Required | codex')
      await expectBlue('waiting for the user clears the glow', 0)
      t.equal(
        `${label}: action required has an amber dot`,
        await icon.locator('.bg-status-waiting').count(),
        1
      )
      await send('codex | Working')
      await expectBlue('work resumes after a question', 1)
      await send('codex | Ready')
      await expectBlue('completion or interruption clears the glow', 0)
      await send('codex | Working')
      await expectBlue('another turn lights the icon', 1)
      await send('shell title')
      await expectBlue('unknown titles cannot leave a stale glow', 0)

      // A selected neighbouring tab must not stop background title processing.
      const other = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'terminal',
        name: `Other ${label}`
      })
      await send('codex | Thinking')
      await expectBlue('background work still lights the Codex row', 1)
      await send('codex | Ready')
      await expectBlue('background completion clears it too', 0)
      await send('codex | Working')
      await expectBlue('working before exit', 1)
      await send('exit')
      await expectBlue('process exit clears the glow', 0)
      t.equal(`${label}: ended Codex icon dims`, await icon.locator('svg.opacity-50').count(), 1)
      await callMcp(app, 'closeSession', { sessionId: other.sessionId })
      await callMcp(app, 'closeSession', { sessionId: id })
    }
    t.check(
      'launch command requests the runtime title without changing user config',
      readFileSync(ARGS, 'utf8').includes('tui.terminal_title=')
    )
  } finally {
    await app.close()
    killLeakedE2eTmux()
  }
}
