import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  until,
  fixturePath,
  serverDataDirOf,
  callMcpIn,
  identityOf,
  openWindow,
  serverMode
} from './harness.mjs'

const SECRET = 'triage-forbidden-environment-sentinel-1021'

function recordingProviders(root) {
  const bin = path.join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    `${bin}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  for (const family of ['claude', 'codex']) {
    writeFileSync(
      `${bin}/${family}`,
      `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv.includes('-p') && !argv.includes('--input-format')) process.exit(0);
const file = ${JSON.stringify(`${root}/${family}-calls.jsonl`)};
const record = value => fs.appendFileSync(file, JSON.stringify(value) + '\\n');
record({kind:'spawn', pid:process.pid, argv, cwd:process.cwd(), codexHome:process.env.CODEX_HOME});
if (argv.includes('--fixture-fail')) { record({kind:'startup-failure', code:23}); process.stderr.write('Fixture provider startup failed\\n'); process.exit(23); }
if (!argv.includes('app-server') && !argv.includes('--input-format')) {
  process.stdout.write('TRIAGE_TERMINAL_READY\\n');
  setInterval(() => {}, 1000);
  return;
}
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const f = JSON.parse(line);
  record({kind:'input', frame:f});
  if (${JSON.stringify(family)} === 'claude') {
    if (f.type !== 'user') return;
    const id = argv[argv.indexOf('--session-id') + 1];
    const frames = fs.readFileSync(${JSON.stringify(path.join(REPO, 'src/main/sessions/fixtures/claude-stream/real-turn.ndjson'))}, 'utf8').trim().split('\\n').map(JSON.parse);
    for (const frame of frames) { if (frame.session_id) frame.session_id = id; send(frame); }
  } else {
    if (f.method === 'initialize') send({id:f.id,result:{}});
    if (f.method === 'thread/start') send({id:f.id,result:{thread:{id:'triage-'+process.pid},model:'fixture'}});
    if (f.method === 'turn/start') {
      send({id:f.id,result:{turn:{id:'turn-'+process.pid}}});
      send({method:'item/agentMessage/delta',params:{threadId:'triage-'+process.pid,itemId:'answer',delta:'TRIAGE_RECORDING_OK'}});
      send({method:'turn/completed',params:{threadId:'triage-'+process.pid,turn:{id:'turn-'+process.pid}}});
    }
  }
});
`,
      { mode: 0o755 }
    )
  }
  return bin
}

const records = (root, family) =>
  existsSync(`${root}/${family}-calls.jsonl`)
    ? readFileSync(`${root}/${family}-calls.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    : []
const stableSessions = (snapshot) => {
  assert.equal(snapshot.sessions.status, 'ok', 'server session inventory must answer')
  return snapshot.sessions.value.map(
    ({ id, provider, transport, adapterId, windowKey, groupId, createdAt, userLabel }) => ({
      id,
      provider,
      transport,
      adapterId,
      windowKey,
      groupId,
      createdAt,
      userLabel
    })
  )
}

async function launchPreferences(win) {
  return win.evaluate(async () => {
    const keys = ['lastAgentSetupByWorkspace', 'selectedClaudeProfileId', 'selectedCodexAccountId']
    return Object.fromEntries(
      await Promise.all(
        keys.map(async (key) => [key, await window.electronAPI.preferencesGet(key)])
      )
    )
  })
}

function ownedTmuxSessions(root) {
  let rows
  try {
    rows = execFileSync(
      'tmux',
      ['-L', 'clave', 'list-sessions', '-F', '#{session_name}|#{session_path}'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (error) {
    if (/no server running|error connecting.*No such file/.test(String(error.stderr))) return []
    throw error
  }
  const roots = [root, realpathSync(root)]
  return rows
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((row) => ({ name: row.slice(0, row.indexOf('|')), cwd: row.slice(row.indexOf('|') + 1) }))
    .filter(({ cwd }) => roots.some((prefix) => cwd === prefix || cwd.startsWith(prefix + '/')))
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function openTriage(app, win) {
  const identity = await identityOf(win)
  await app.evaluate(({ BrowserWindow }, id) => {
    // Route the menu's preload event to the non-primary hidden fixture window.
    BrowserWindow.fromId(id).webContents.send('menu:open-triage')
  }, identity.windowId)
  const dialog = win.getByRole('dialog', { name: 'Debug Clave', exact: true })
  await dialog.waitFor()
  await dialog.getByTestId('triage-summary').waitFor({ timeout: 25_000 })
  await dialog
    .getByRole('button', { name: 'Triage launch profile', exact: true })
    .waitFor({ state: 'visible' })
  await until(() =>
    dialog.getByRole('button', { name: /Capture again|Check support tab/ }).isEnabled()
  )
  return dialog
}

async function choose(win, label, value) {
  await win.getByRole('button', { name: label, exact: true }).click()
  await win.getByRole('menuitem', { name: value, exact: true }).click()
}

export async function run(t) {
  const fixtureModule = fixturePath('triage-scenario.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/triage-fixture.mjs')],
    outfile: fixtureModule,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadTriageScenario } = await import(pathToFileURL(fixtureModule).href)
  let app
  let fixtureRoot
  try {
    const receipt = await loadTriageScenario(async ({ runId, id }) => {
      const root = fixturePath(`triage-${runId}`)
      fixtureRoot = root
      const data = path.join(root, 'data')
      const home = path.join(root, 'codex-home')
      mkdirSync(home, { recursive: true })
      writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ fixture: true }))
      const bin = recordingProviders(root)
      const workspace = {
        id: id('workspace'),
        name: 'Triage visible',
        rootDir: root,
        profileFile: null,
        createdAt: 1
      }
      const hidden = { ...workspace, id: id('hidden'), name: 'Triage hidden' }
      seedWorkspaces(data, { workspaces: [workspace, hidden], activeWorkspaceId: workspace.id })
      seedTrustedRoots(data, [root])
      const launched = await launchApp(data, {
        env: {
          SHELL: `${bin}/bash`,
          CODEX_HOME: home,
          TRIAGE_SECRET_SENTINEL: SECRET,
          CLAVE_TRANSCRIPTS_ROOT: `${root}/transcripts`
        },
        args: ['--dev-echo-adapter', '--test-no-machine-usage']
      })
      app = launched.app
      const win = launched.win
      win.setDefaultTimeout(12_000)
      for (const family of ['claude', 'codex'])
        await win.evaluate(
          ({ family, bin }) =>
            window.electronAPI.launchProfileUpsert({
              id: `triage-${family}`,
              name: `${family} recording`,
              family,
              command: [`${bin}/${family}`],
              additionalArgs:
                family === 'codex'
                  ? ['--sandbox', 'read-only', '--ask-for-approval', 'on-request']
                  : ['--permission-mode', 'default']
            }),
          { family, bin }
        )
      // Title generation for a Codex tab uses the workspace's Claude CLI.
      // Keep that outgoing effect on the recording wrapper as well.
      await win.evaluate(
        (workspaceId) =>
          window.electronAPI.launchProfileSetWorkspace(workspaceId, 'claude', 'triage-claude'),
        workspace.id
      )
      await win.evaluate(
        async ({ workspaceId, bin }) => {
          await window.electronAPI.launchProfileUpsert({
            id: 'triage-codex-fallback',
            name: 'codex fallback recording',
            family: 'codex',
            command: [`${bin}/codex`],
            additionalArgs: ['--sandbox', 'read-only']
          })
          await window.electronAPI.launchProfileSetWorkspace(
            workspaceId,
            'codex',
            'triage-codex-fallback'
          )
        },
        { workspaceId: workspace.id, bin }
      )
      await win.evaluate(
        (bin) =>
          window.electronAPI.launchProfileUpsert({
            id: 'triage-codex-failed',
            name: 'codex failing recording',
            family: 'codex',
            command: [`${bin}/codex`, '--fixture-fail'],
            additionalArgs: []
          }),
        bin
      )
      const account = await win.evaluate(() =>
        window.electronAPI.codexAccountAdd({ label: 'Triage Codex account', kind: 'chatgpt' })
      )
      const accountHome = path.join(serverDataDirOf(data), 'codex-homes', account.id)
      mkdirSync(accountHome, { recursive: true })
      writeFileSync(path.join(accountHome, 'auth.json'), JSON.stringify({ fixture: true }))
      await win.reload()
      await win.locator('.launcher-caret').waitFor()
      const first = await identityOf(win)
      const group = await callMcpIn(app, first.windowId, 'createGroup', {
        name: `Triage fixture ${runId}`
      })
      const tick = await callMcpIn(app, first.windowId, 'openSession', {
        mode: 'terminal',
        cwd: root,
        groupId: group.groupId,
        command: `echo $$ > '${root}/ticker.pid'; i=0; while true; do i=$((i+1)); echo tick-$i >> '${root}/ticks'; sleep 0.2; done`,
        autoRun: true
      })
      assert.ok(
        await until(
          () =>
            existsSync(`${root}/ticks`) && readFileSync(`${root}/ticks`, 'utf8').includes('tick-2')
        ),
        'ticking terminal starts'
      )
      const live = await callMcpIn(app, first.windowId, 'openSession', {
        mode: 'codex',
        cwd: root,
        profile: 'chat:codex:triage-codex',
        account: 'default',
        prompt: 'Live chat positive control'
      })
      assert.ok(
        await until(() =>
          records(root, 'codex').some((r) => r.kind === 'input' && r.frame.method === 'turn/start')
        ),
        'live chat completes a real protocol turn'
      )
      const dormant = await win.evaluate(
        (root) =>
          window.electronAPI.spawnSession(root, {
            claudeMode: true,
            launchProfileId: 'dev-echo-adapter'
          }),
        root
      )
      const hiddenTab = await callMcpIn(app, first.windowId, 'openSession', {
        mode: 'terminal',
        cwd: root,
        workspace: hidden.id
      })
      const second = await openWindow(app, win, workspace.id)
      second.page.setDefaultTimeout(12_000)
      return {
        root,
        data,
        win,
        second: second.page,
        first,
        account,
        accountHome,
        tick,
        live,
        dormant,
        hiddenTab,
        workspace
      }
    })
    const f = receipt.values.app
    const { root, data, win, second } = f
    const before = await win.evaluate(() => window.electronAPI.triageSnapshot())
    const original = stableSessions(before)
    assert.ok(original.some((s) => s.id === f.dormant.id))
    assert.equal(before.windows.length, 2)
    const prefsBefore = await win.evaluate(() => window.electronAPI.launchProfilesList())
    const launchPrefsBefore = await launchPreferences(win)
    const tickBefore = readFileSync(`${root}/ticks`, 'utf8').split('\n').length
    const tickerPid = readFileSync(`${root}/ticker.pid`, 'utf8')
    const originalChatPid = records(root, 'codex').find(
      (r) => r.kind === 'spawn' && r.cwd === realpathSync(root)
    ).pid
    assert.ok(processAlive(originalChatPid), 'the original chat process is alive before triage')
    const dialog = await openTriage(app, second)
    await dialog.getByText('Preview context', { exact: true }).click()
    const context = await dialog.getByLabel('Context preview').textContent()
    assert.ok(context.includes(before.origin.instanceId), 'preview binds this app instance')
    assert.ok(!context.includes(SECRET), 'environment sentinel omitted')
    for (const s of original)
      assert.ok(context.includes(s.id), `preview includes preexisting ${s.id}`)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(
      stableSessions(await win.evaluate(() => window.electronAPI.triageSnapshot())),
      original,
      'cancel creates no session'
    )
    t.check(
      'native entry captures the exact instance across windows and cancel preserves all sessions',
      true
    )
    await second.keyboard.press('Meta+Shift+/')
    await second.getByRole('button', { name: 'Debug Clave…', exact: true }).click()
    await dialog.waitFor()
    await choose(second, 'Triage provider', 'Codex')
    await choose(second, 'Triage launch profile', 'codex recording (chat)')
    await choose(second, 'Triage account', 'Triage Codex account')
    await dialog
      .getByRole('textbox', { name: 'What went wrong?' })
      .fill('The session list stopped updating.')
    await dialog.getByRole('button', { name: 'Copy support prompt', exact: true }).click()
    await dialog.getByText('Copied', { exact: true }).waitFor()
    const copied = await second.evaluate(() => navigator.clipboard.readText())
    assert.ok(copied.includes('The session list stopped updating.'))
    assert.ok(!copied.includes(SECRET))
    if (serverMode() === 'attached') {
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Start support conversation', exact: true })
          .isDisabled(),
        true
      )
      assert.ok(await dialog.getByText(/filesystem may be elsewhere/).isVisible())
      await dialog.getByRole('button', { name: 'Copy external command', exact: true }).click()
      await dialog.getByText('Copied', { exact: true }).waitFor()
      assert.deepEqual(
        stableSessions(await win.evaluate(() => window.electronAPI.triageSnapshot())),
        original
      )
      t.check(
        'attached server uses explicit same-machine fallback and creates no support tab',
        true
      )
    } else {
      const callsBefore = records(root, 'codex').filter((r) => r.kind === 'spawn').length
      const start = dialog.getByRole('button', { name: 'Start support conversation', exact: true })
      // Two events in one task exercise the controller guard before async preflight.
      await start.evaluate((button) => {
        button.click()
        button.click()
      })
      await dialog.getByText(/Support tab created\. It uses this capture/).waitFor()
      assert.ok(
        await until(
          () => records(root, 'codex').filter((r) => r.kind === 'spawn').length === callsBefore + 1
        ),
        'recording Codex process actually starts'
      )
      const after = await second.evaluate(() => window.electronAPI.triageSnapshot())
      const support = after.sessions.value.filter((s) => !original.some((o) => o.id === s.id))
      assert.equal(support.length, 1, 'double submit creates exactly one tab')
      assert.equal(support[0].windowKey, (await identityOf(second)).windowKey)
      const supportListing = after.windowListings.find(
        (s) => s.windowId === after.origin.windowId && s.status === 'ok'
      )
      assert.equal(
        supportListing.value.sessions.find((s) => s.id === support[0].id).workspaceId,
        f.workspace.id,
        'support retains the captured workspace'
      )
      assert.ok(
        await until(
          async () =>
            (await second.evaluate(() => window.electronAPI.triageSnapshot())).sessions.value.find(
              (s) => s.id === support[0].id
            )?.userLabel === 'Clave triage'
        ),
        'support name persists on its own record'
      )
      const invocation = records(root, 'codex')
        .filter((r) => r.kind === 'spawn')
        .at(-1)
      assert.equal(invocation.codexHome, f.accountHome)
      const thread = records(root, 'codex')
        .filter((r) => r.kind === 'input' && r.frame.method === 'thread/start')
        .at(-1).frame
      assert.equal(thread.params.sandbox, 'read-only')
      assert.equal(thread.params.approvalPolicy, 'on-request')
      assert.ok(invocation.cwd.includes('/triage/'))
      const promptFile = readdirSync(invocation.cwd).find((name) => /prompt|playbook/.test(name))
      assert.ok(promptFile, 'launched cwd contains the prepared support playbook')
      const launchInput = records(root, 'codex')
        .filter((r) => r.kind === 'input' && r.frame.method === 'turn/start')
        .at(-1)
      assert.ok(JSON.stringify(launchInput).includes('The session list stopped updating.'))
      assert.ok(!JSON.stringify(records(root, 'codex')).includes(SECRET))
      assert.deepEqual(
        stableSessions(after).filter((s) => original.some((o) => o.id === s.id)),
        original
      )
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await openTriage(app, second)
      assert.equal(
        await dialog.getByRole('button', { name: 'Support tab created', exact: true }).isDisabled(),
        true
      )
      assert.equal(records(root, 'codex').filter((r) => r.kind === 'spawn').length, callsBefore + 1)
      t.check(
        'Codex uses the chosen account/profile/policy, exact capture and one support tab in the invoking window',
        true
      )
      await app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu()
        const item = menu.items
          .find((entry) => entry.label === 'Help')
          .submenu.items.find((entry) => entry.label === 'Debug Clave…')
        if (!item) throw new Error('Native Debug Clave menu item is missing')
        item.click()
      })
      const claudeDialog = await openTriage(app, win)
      await choose(win, 'Triage launch profile', 'claude recording (chat)')
      await claudeDialog
        .getByRole('button', { name: 'Start support conversation', exact: true })
        .click()
      await claudeDialog.getByText(/Support tab created\. It uses this capture/).waitFor()
      assert.ok(
        await until(() => records(root, 'claude').some((r) => r.kind === 'input')),
        'recording Claude process receives the prepared first prompt'
      )
      const claude = records(root, 'claude').find((r) => r.kind === 'spawn')
      assert.ok(claude.argv.includes('--permission-mode'))
      assert.equal(claude.argv[claude.argv.indexOf('--permission-mode') + 1], 'default')
      assert.ok(!claude.argv.includes('--dangerously-skip-permissions'))
      t.check(
        'Claude chat starts through its exact offered profile without adding a permission bypass',
        true
      )
      const failureWindow = (await openWindow(app, win, f.workspace.id)).page
      failureWindow.setDefaultTimeout(12_000)
      const failureDialog = await openTriage(app, failureWindow)
      await choose(failureWindow, 'Triage provider', 'Codex')
      await choose(failureWindow, 'Triage launch profile', 'codex recording (chat)')
      const countBeforeFailure = stableSessions(
        await failureWindow.evaluate(() => window.electronAPI.triageSnapshot())
      ).length
      await failureWindow.evaluate(() => window.electronAPI.launchProfileDelete('triage-codex'))
      await failureDialog
        .getByRole('button', { name: 'Start support conversation', exact: true })
        .click()
      await failureDialog
        .getByRole('alert')
        .filter({ hasText: /selected launch profile is no longer available/ })
        .waitFor()
      assert.equal(
        stableSessions(await failureWindow.evaluate(() => window.electronAPI.triageSnapshot()))
          .length,
        countBeforeFailure
      )
      await failureWindow.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async () => {
              throw new Error('fixture clipboard denied')
            }
          }
        })
      })
      await failureDialog.getByRole('button', { name: 'Copy context', exact: true }).click()
      await failureDialog
        .getByText('Copy failed. Select and copy the preview text.', { exact: true })
        .waitFor()
      await failureWindow.evaluate(() => {
        delete navigator.clipboard
      })
      await failureWindow.evaluate(
        (profile) => window.electronAPI.launchProfileUpsert(profile),
        prefsBefore.customProfiles.find((p) => p.id === 'triage-codex')
      )
      t.check(
        'a disappeared profile creates no alternate session and clipboard rejection is reported honestly',
        true
      )
      const terminalDialog = failureDialog
      await terminalDialog.getByRole('button', { name: 'Capture again', exact: true }).click()
      assert.ok(
        await until(() =>
          terminalDialog.getByRole('button', { name: 'Capture again', exact: true }).isEnabled()
        )
      )
      await choose(failureWindow, 'Triage provider', 'Codex')
      await choose(failureWindow, 'Triage launch profile', 'codex recording')
      await choose(failureWindow, 'Triage account', 'Triage Codex account')
      await terminalDialog.getByRole('button', { name: 'Copy support prompt', exact: true }).click()
      await terminalDialog.getByText('Copied', { exact: true }).waitFor()
      const terminalPrompt = await failureWindow.evaluate(() => navigator.clipboard.readText())
      const beforeTerminal = records(root, 'codex').filter((r) => r.kind === 'spawn').length
      await terminalDialog
        .getByRole('button', { name: 'Start support conversation', exact: true })
        .click()
      await terminalDialog.getByText(/Support tab created\. It uses this capture/).waitFor()
      assert.ok(
        await until(
          () =>
            records(root, 'codex').filter((r) => r.kind === 'spawn').length === beforeTerminal + 1
        ),
        'support terminal process starts'
      )
      const terminal = records(root, 'codex')
        .filter((r) => r.kind === 'spawn')
        .at(-1)
      assert.equal(terminal.codexHome, f.accountHome)
      assert.ok(terminal.argv.includes('read-only'))
      assert.ok(
        terminal.argv.includes(terminalPrompt),
        'terminal receives the exact prepared support prompt'
      )
      assert.ok(!terminal.argv.includes('--yolo'))
      t.check(
        'the offered terminal route actually starts with the chosen account and permissions',
        true
      )
      if (serverMode() === 'in-process') {
        // Delete AFTER preflight, at the real host boundary. The ordinary
        // terminal fallback must be refused before any pane supplies a size.
        await win.evaluate(
          (root) =>
            window.electronAPI.launchProfileUpsert({
              id: 'triage-codex-race',
              name: 'codex race recording',
              family: 'codex',
              command: [`${root}/bin/codex`],
              additionalArgs: []
            }),
          root
        )
        const raceWindow = (await openWindow(app, win, f.workspace.id)).page
        raceWindow.setDefaultTimeout(12_000)
        // sessions:list is window-scoped. Give this window an existing handle
        // so cleanup cannot pass merely because the window started empty.
        const previousHandle = await raceWindow.evaluate(
          (root) => window.electronAPI.spawnSession(root, {}),
          root
        )
        const raceDialog = await openTriage(app, raceWindow)
        await choose(raceWindow, 'Triage provider', 'Codex')
        await choose(raceWindow, 'Triage launch profile', 'codex race recording')
        await choose(raceWindow, 'Triage account', 'Triage Codex account')
        const beforeRace = stableSessions(
          await raceWindow.evaluate(() => window.electronAPI.triageSnapshot())
        )
        const processesBeforeRace = records(root, 'codex').filter((r) => r.kind === 'spawn').length
        await app.evaluate(() => {
          const host = globalThis.__claveE2E.sessionHost
          const original = host.start
          host.start = async (input) => {
            if (input.options?.launchProfileId !== 'triage-codex-race') return original(input)
            host.start = original
            globalThis.__claveE2E.settings.launchProfiles.delete('triage-codex-race')
            const info = await original(input)
            globalThis.__triageProfileRace = { id: info.id, actualProfile: info.launchProfileId }
            return info
          }
        })
        await raceDialog
          .getByRole('button', { name: 'Start support conversation', exact: true })
          .click()
        await raceDialog
          .getByRole('alert')
          .filter({ hasText: /unused handle was removed/ })
          .waitFor()
        const race = await app.evaluate(() => globalThis.__triageProfileRace)
        assert.equal(race.actualProfile, 'triage-codex-fallback')
        assert.ok(beforeRace.some((session) => session.id === previousHandle.id))
        assert.deepEqual(
          stableSessions(await raceWindow.evaluate(() => window.electronAPI.triageSnapshot())),
          beforeRace,
          'only the new fallback handle is removed'
        )
        await raceWindow.waitForTimeout(300)
        assert.equal(
          records(root, 'codex').filter((r) => r.kind === 'spawn').length,
          processesBeforeRace,
          'the mismatched prepared terminal never starts its recording process'
        )
        t.check(
          'a post-preflight profile race removes only its new unstarted handle and preserves every existing session',
          true
        )
      }
      const failedWindow = (await openWindow(app, win, f.workspace.id)).page
      failedWindow.setDefaultTimeout(12_000)
      const failedDialog = await openTriage(app, failedWindow)
      await choose(failedWindow, 'Triage provider', 'Codex')
      await choose(failedWindow, 'Triage launch profile', 'codex failing recording (chat)')
      await choose(failedWindow, 'Triage account', 'Triage Codex account')
      await failedDialog
        .getByRole('button', { name: 'Start support conversation', exact: true })
        .click()
      await failedDialog.getByText(/Support tab created\. It uses this capture/).waitFor()
      assert.ok(
        await until(() =>
          records(root, 'codex').some((r) => r.kind === 'startup-failure' && r.code === 23)
        ),
        'recording provider really fails during startup'
      )
      await failedDialog.getByRole('button', { name: 'Copy context', exact: true }).click()
      await failedDialog.getByText('Copied', { exact: true }).waitFor()
      const failedCopies = await failedWindow.evaluate(() => navigator.clipboard.readText())
      assert.ok(failedCopies.includes(before.origin.instanceId))
      assert.equal(
        await failedDialog
          .getByRole('button', { name: 'Support tab created', exact: true })
          .isDisabled(),
        true
      )
      t.check(
        'copy fallback remains usable after an actual provider process startup failure, without respawning',
        true
      )
      if (serverMode() === 'in-process') {
        const claudeAccountId = 'triage-fixture-claude-account'
        // Supply only synthetic metadata and an injected token lookup in this
        // hidden app. Nothing is written to credentials, Keychain or config.
        await app.evaluate((_, accountId) => {
          const accounts = globalThis.__claveE2E.settings.claudeAccounts
          const list = accounts.list
          const getToken = accounts.getToken
          const host = globalThis.__claveE2E.sessionHost
          const start = host.start
          const race = { cleared: false, requested: null }
          globalThis.__triageClaudeAccountRace = race
          accounts.list = () => [
            ...list.call(accounts),
            {
              id: accountId,
              label: 'Fixture Claude account',
              hasToken: !race.cleared,
              tokenSetAt: 1,
              tokenExpiresAt: null,
              tokenInvalid: false
            }
          ]
          accounts.getToken = (id) =>
            id === accountId
              ? race.cleared
                ? undefined
                : 'fixture-only-never-persisted'
              : getToken.call(accounts, id)
          host.start = async (input) => {
            if (input.options?.launchProfileId !== 'triage-claude') return start(input)
            host.start = start
            race.cleared = true
            race.requested = input.options.claudeProfileId
            return start(input)
          }
          globalThis.__restoreTriageClaudeAccountRace = () => {
            accounts.list = list
            accounts.getToken = getToken
            host.start = start
          }
        }, claudeAccountId)
        try {
          const claudeRaceWindow = (await openWindow(app, win, f.workspace.id)).page
          claudeRaceWindow.setDefaultTimeout(12_000)
          const claudeRaceDialog = await openTriage(app, claudeRaceWindow)
          await choose(claudeRaceWindow, 'Triage launch profile', 'claude recording')
          await choose(claudeRaceWindow, 'Triage account', 'Fixture Claude account')
          const beforeClaudeRace = await claudeRaceWindow.evaluate(() =>
            window.electronAPI.triageSnapshot()
          )
          const claudeSpawns = records(root, 'claude').filter((r) => r.kind === 'spawn').length
          await claudeRaceDialog
            .getByRole('button', { name: 'Start support conversation', exact: true })
            .click()
          assert.ok(
            await until(() =>
              app.evaluate(() => globalThis.__triageClaudeAccountRace?.cleared === true)
            ),
            'the synthetic token lookup is cleared after renderer preflight'
          )
          const race = await app.evaluate(() => globalThis.__triageClaudeAccountRace)
          assert.equal(race.requested, claudeAccountId)
          await claudeRaceDialog
            .getByRole('alert')
            .filter({ hasText: /Startup could not be confirmed/ })
            .waitFor()
          assert.equal(
            records(root, 'claude').filter((r) => r.kind === 'spawn').length,
            claudeSpawns,
            'a cleared explicit token never starts a process using the machine login'
          )
          const afterClaudeRace = await claudeRaceWindow.evaluate(() =>
            window.electronAPI.triageSnapshot()
          )
          assert.deepEqual(
            afterClaudeRace.sessions.value.map((s) => s.id),
            beforeClaudeRace.sessions.value.map((s) => s.id),
            'a cleared Claude token creates no session and preserves previous handles'
          )
          assert.equal(beforeClaudeRace.records.status, 'ok')
          assert.equal(afterClaudeRace.records.status, 'ok')
          assert.deepEqual(
            afterClaudeRace.records.value.items.map((r) => r.key).sort(),
            beforeClaudeRace.records.value.items.map((r) => r.key).sort(),
            'a refused Claude launch creates no orphan restore record'
          )
          await claudeRaceDialog.getByRole('button', { name: 'Copy context', exact: true }).click()
          await claudeRaceDialog.getByText('Copied', { exact: true }).waitFor()
          t.check(
            'a Claude token cleared after preflight refuses startup without a machine-login process or orphan record',
            true
          )
        } finally {
          await app.evaluate(() => globalThis.__restoreTriageClaudeAccountRace())
        }
        const accountRaceWindow = (await openWindow(app, win, f.workspace.id)).page
        accountRaceWindow.setDefaultTimeout(12_000)
        const accountRaceDialog = await openTriage(app, accountRaceWindow)
        await choose(accountRaceWindow, 'Triage provider', 'Codex')
        await choose(accountRaceWindow, 'Triage launch profile', 'codex recording (chat)')
        await choose(accountRaceWindow, 'Triage account', 'Triage Codex account')
        const beforeAccountRace = await accountRaceWindow.evaluate(() =>
          window.electronAPI.triageSnapshot()
        )
        const spawnsBeforeAccountRace = records(root, 'codex').filter(
          (r) => r.kind === 'spawn'
        ).length
        await app.evaluate((_, accountId) => {
          const host = globalThis.__claveE2E.sessionHost
          const original = host.start
          host.start = async (input) => {
            if (input.options?.launchProfileId !== 'chat:codex:triage-codex') return original(input)
            host.start = original
            const removed = globalThis.__claveE2E.settings.codexAccounts.remove(accountId)
            globalThis.__triageAccountRace = { removed, requested: input.options.codexAccountId }
            return original(input)
          }
        }, f.account.id)
        await accountRaceDialog
          .getByRole('button', { name: 'Start support conversation', exact: true })
          .click()
        assert.ok(
          await until(() => app.evaluate(() => globalThis.__triageAccountRace?.removed === true)),
          'the account was removed at the real host boundary after renderer preflight'
        )
        const accountRace = await app.evaluate(() => globalThis.__triageAccountRace)
        assert.equal(
          accountRace.requested,
          f.account.id,
          'main received the explicit chosen account'
        )
        await accountRaceDialog
          .getByRole('alert')
          .filter({ hasText: /Startup could not be confirmed/ })
          .waitFor()
        assert.equal(
          records(root, 'codex').filter((r) => r.kind === 'spawn').length,
          spawnsBeforeAccountRace,
          'neither the selected nor the Default provider process starts after account removal'
        )
        const afterAccountRace = await accountRaceWindow.evaluate(() =>
          window.electronAPI.triageSnapshot()
        )
        assert.deepEqual(
          afterAccountRace.sessions.value.map((s) => s.id),
          beforeAccountRace.sessions.value.map((s) => s.id),
          'a removed account creates no session and preserves every previous handle'
        )
        assert.equal(
          await accountRaceDialog
            .getByRole('button', { name: 'Check existing tabs', exact: true })
            .isDisabled(),
          true,
          'generic refusal never enables an unconfirmed retry'
        )
        await accountRaceDialog.getByRole('button', { name: 'Copy context', exact: true }).click()
        await accountRaceDialog.getByText('Copied', { exact: true }).waitFor()
        t.check(
          'an account removed after preflight refuses startup without a Default process or changes to existing sessions',
          true
        )
      }
    }
    const final = await win.evaluate(() => window.electronAPI.triageSnapshot())
    assert.deepEqual(
      stableSessions(final).filter((s) => original.some((o) => o.id === s.id)),
      original
    )
    assert.ok(
      readFileSync(`${root}/ticks`, 'utf8').split('\n').length > tickBefore,
      'existing terminal keeps ticking'
    )
    assert.equal(
      readFileSync(`${root}/ticker.pid`, 'utf8'),
      tickerPid,
      'the existing terminal keeps its process identity'
    )
    assert.equal(
      records(root, 'codex').filter((r) => r.kind === 'spawn' && r.cwd === realpathSync(root))
        .length,
      1,
      'the existing chat keeps its one provider process'
    )
    assert.ok(processAlive(originalChatPid), 'the same original chat process is still alive')
    assert.equal(
      final.sessions.value.find((s) => s.id === f.dormant.id).state,
      before.sessions.value.find((s) => s.id === f.dormant.id).state,
      'the dormant chat remains idle'
    )
    for (const listing of before.windowListings.filter((s) => s.status === 'ok')) {
      const afterListing = final.windowListings.find(
        (s) => s.windowId === listing.windowId && s.status === 'ok'
      )
      assert.ok(afterListing)
      for (const group of listing.value.groups)
        assert.deepEqual(
          afterListing.value.groups.find((g) => g.id === group.id),
          group,
          'existing group and workspace assignments stay intact'
        )
    }
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'Existing chat still accepts work'
        }),
      f.live.sessionId
    )
    assert.ok(
      await until(() =>
        JSON.stringify(records(root, 'codex')).includes('Existing chat still accepts work')
      )
    )
    const prefsAfter = await win.evaluate(() => window.electronAPI.launchProfilesList())
    assert.deepEqual(
      await launchPreferences(win),
      launchPrefsBefore,
      'triage preserves remembered agent setups and selected provider accounts'
    )
    assert.deepEqual(
      prefsAfter.globalDefaults,
      prefsBefore.globalDefaults,
      'triage writes no global launch defaults'
    )
    assert.deepEqual(
      prefsAfter.workspaceOverrides,
      prefsBefore.workspaceOverrides,
      'triage writes no workspace launch defaults'
    )
    assert.deepEqual(
      prefsAfter.customProfiles.toSorted((a, b) => a.id.localeCompare(b.id)),
      prefsBefore.customProfiles.toSorted((a, b) => a.id.localeCompare(b.id)),
      'profile disappearance fixture restores all definitions'
    )
    const receiptPath = path.join(root, 'receipt.json')
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          scenario: 'triage/current-instance',
          runId: receipt.runId,
          mode: serverMode(),
          data,
          instance: before.origin,
          original,
          finalSessionIds: final.sessions.value.map((s) => s.id),
          checks: 'instance, window, account, profile policy, prompt, continuity, fallback'
        },
        null,
        2
      )
    )
    console.log(
      JSON.stringify({
        scenario: 'triage/current-instance',
        runId: receipt.runId,
        mode: serverMode(),
        receipt: receiptPath
      })
    )
    t.check(
      'live chat/terminal, hidden workspace, dormant chat, original IDs and assignments survive triage',
      true
    )
  } finally {
    try {
      await app?.close()
    } finally {
      if (fixtureRoot && existsSync(fixtureRoot)) {
        // A support terminal's cwd is a capture timestamp, so its tmux name
        // lacks the harness prefix. Scope by this exact fixture's start path,
        // then address each owned session by exact name after all assertions.
        const owned = ownedTmuxSessions(fixtureRoot)
        for (const { name } of owned)
          execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${name}`], {
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'pipe']
          })
        assert.deepEqual(ownedTmuxSessions(fixtureRoot), [], 'no fixture tmux sessions remain')
        const pids = ['claude', 'codex'].flatMap((family) =>
          records(fixtureRoot, family)
            .filter((r) => r.kind === 'spawn')
            .map((r) => r.pid)
        )
        assert.ok(
          await until(() => pids.every((pid) => !processAlive(pid))),
          'all recording provider processes stop after fixture teardown'
        )
        writeFileSync(
          path.join(fixtureRoot, 'teardown.json'),
          JSON.stringify({ owned, pids, remainingTmux: [], remainingProviders: [] }, null, 2)
        )
        t.check('fixture teardown removes only its own tmux sessions and recording processes', true)
      }
    }
  }
}
