import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  until,
  fixturePath
} from './harness.mjs'

export async function run(t) {
  const root = fixturePath(`chat-profiles-${process.pid}`)
  const data = `${root}/data`
  const bin = `${root}/bin`
  const literal = "account's $(echo unexpected); with spaces"
  mkdirSync(bin, { recursive: true })
  seedWorkspaces(data, {
    workspaces: [
      { id: 'profiles', name: 'Profiles', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'profiles',
    fresh: true
  })
  seedTrustedRoots(data, [root])
  writeFileSync(
    `${bin}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // Both wrappers record the actual process arguments and speak the chat protocol.
  // A literal shell expression must arrive unchanged; it must never be evaluated.
  for (const family of ['claude', 'codex']) {
    writeFileSync(
      `${bin}/${family} wrapper`,
      `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(`${root}/${family}.json`)}, JSON.stringify(argv));
const send = f => process.stdout.write(JSON.stringify(f) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const f = JSON.parse(line);
  if (${JSON.stringify(family)} === 'claude') {
    if (f.type !== 'user') return;
    const id = argv[argv.indexOf('--session-id') + 1];
    const frames = fs.readFileSync(${JSON.stringify(path.join(REPO, 'src/main/sessions/fixtures/claude-stream/real-turn.ndjson'))}, 'utf8').trim().split('\\n').map(JSON.parse);
    for (const frame of frames) { if (frame.session_id) frame.session_id = id; send(frame); }
  } else {
    if (f.method === 'initialize') send({id:f.id,result:{}});
    if (f.method === 'thread/start') send({id:f.id,result:{thread:{id:'profile-thread'},model:'fixture'}});
    if (f.method === 'turn/start') {
      send({id:f.id,result:{turn:{id:'profile-turn'}}});
      send({method:'item/agentMessage/delta',params:{threadId:'profile-thread',itemId:'answer',delta:'CODEX_PROFILE_OK'}});
      send({method:'turn/completed',params:{threadId:'profile-thread',turn:{id:'profile-turn'}}});
    }
  }
});
`,
      { mode: 0o755 }
    )
  }
  let app
  try {
    const launched = await launchApp(data, {
      env: { SHELL: `${bin}/bash`, CLAVE_TRANSCRIPTS_ROOT: `${root}/transcripts` }
    })
    app = launched.app
    const win = launched.win
    for (const family of ['claude', 'codex']) {
      await win.evaluate(
        ({ family, bin, literal }) =>
          window.electronAPI.launchProfileUpsert({
            id: `${family}-work`,
            name: `${family} work`,
            family,
            command: [`${bin}/${family} wrapper`, literal],
            additionalArgs: ['--profile', 'work account']
          }),
        { family, bin, literal }
      )
    }
    await win.reload()
    await win.locator('.launcher-caret').waitFor()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'agents')
    })
    await win.getByRole('heading', { name: 'Agents', exact: true }).waitFor()
    for (const family of ['claude', 'codex']) {
      assert.equal(await win.locator(`[data-launch-profile="${family}-work"]`).count(), 1)
      assert.equal(
        await win.locator(`[data-launch-profile="chat:${family}:${family}-work"]`).count(),
        0
      )
      await win.locator(`[data-settings-select="global-${family}"]`).click()
      await win.getByRole('menuitem', { name: `${family} work (chat)`, exact: true }).click()
    }
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    t.check(
      'settings offers chat defaults while keeping one editable definition per saved profile',
      true
    )
    for (const family of ['claude', 'codex']) {
      await win.locator('.launcher-caret').click()
      await win
        .getByRole('menuitem', {
          name: family === 'claude' ? 'Claude Code' : 'Codex CLI',
          exact: true
        })
        .hover()
      await win.getByRole('menuitem', { name: `${family} work (chat)`, exact: true }).click()
      const session = await until(async () =>
        (await win.evaluate(() => window.electronAPI.sessionsList())).find(
          (s) => s.adapterId === `${family}-chat`
        )
      )
      assert.ok(session, `${family} selection must create a chat session`)
      const chat = win.locator('[data-testid="chat-view"]:visible')
      await chat.waitFor()
      await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('hello')
      await chat.getByRole('button', { name: 'Send message', exact: true }).click()
      assert.ok(
        await until(() => existsSync(`${root}/${family}.json`)),
        'Configured wrapper must run'
      )
      const argv = JSON.parse(readFileSync(`${root}/${family}.json`, 'utf8'))
      assert.deepEqual(argv.slice(0, 3), [literal, '--profile', 'work account'])
      assert.ok(argv.includes(family === 'claude' ? '--input-format' : 'app-server'))
      await chat
        .getByRole('log', { name: 'Conversation' })
        .getByText(family === 'claude' ? 'CLAVE_OK' : 'CODEX_PROFILE_OK', { exact: true })
        .waitFor()
      const prefs = await win.evaluate(() => window.electronAPI.launchProfilesList())
      assert.equal(prefs.workspaceOverrides.profiles[family], `chat:${family}:${family}-work`)
      t.check(
        `${family} launcher chat choice runs its wrapper and arguments and completes a conversation`,
        true
      )
    }
    await app.close()
    app = undefined
    const persisted = JSON.parse(readFileSync(`${data}/agent-launch-profiles.json`, 'utf8'))
    assert.equal(persisted.workspaceOverrides.profiles.claude, 'chat:claude:claude-work')
    assert.ok(
      persisted.customProfiles.every((p) => !p.id.startsWith('chat:')),
      'Derived profiles must not be saved as editable copies'
    )
    t.check(
      'chat defaults persist while the saved profile remains the single command definition',
      true
    )
  } finally {
    await app?.close()
    rmSync(root, { recursive: true, force: true })
  }
}
