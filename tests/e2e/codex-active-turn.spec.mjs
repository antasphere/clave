import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  callMcp,
  fixturePath,
  launchApp,
  REPO,
  seedTrustedRoots,
  seedWorkspaces,
  until,
  userDataDir
} from './harness.mjs'

// Synthetic protocol provider, isolated from subscription credentials. The real
// Electron composer, server, session manager and Codex adapter remain in use.
const ROOT = fixturePath('codex-active-turn')
const DIR = userDataDir('codex-active-turn-data')
const BIN = `${ROOT}/bin`
const LOG = `${ROOT}/requests.ndjson`
const requests = () => readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

export async function run(t) {
  const check = async (name, exercise) => {
    await exercise()
    t.check(name, true)
  }
  const waitFor = async (condition) =>
    assert.ok(await until(condition), 'expected condition before deadline')
  mkdirSync(BIN, { recursive: true })
  writeFileSync(LOG, '')
  seedWorkspaces(DIR, {
    workspaces: [
      { id: 'followup', name: 'Follow-up', rootDir: ROOT, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'followup',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${BIN}/codex`,
    `#!${process.execPath}
const fs = require('node:fs');
const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
let turn = 0, active;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const f = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(LOG)}, line+'\\n');
  if (!f.method || f.method === 'initialized') return;
  if (f.method === 'initialize') return send({id:f.id,result:{}});
  if (f.method === 'thread/start') return send({id:f.id,result:{thread:{id:'thread'},model:'fixture-model'}});
  if (f.method === 'turn/start') {
    active = 'turn-'+(++turn);
    send({id:f.id,result:{turn:{id:active,status:'inProgress'}}});
    return send({method:'turn/started',params:{threadId:'thread',turn:{id:active}}});
  }
  if (f.method === 'turn/steer') {
    if (f.params.threadId !== 'thread' || f.params.expectedTurnId !== active) return send({id:f.id,error:{code:-32600,message:'Wrong active turn'}});
    const text = f.params.input.find(i=>i.type==='text')?.text;
    if (text === 'reject this message') return send({id:f.id,error:{code:-32600,message:'Fixture rejected follow-up'}});
    send({id:f.id,result:{turnId:active}});
    send({method:'item/agentMessage/delta',params:{threadId:'thread',itemId:'answer-'+turn,delta:'Received: '+text}});
    if (text === 'finish this turn') {
      send({method:'turn/completed',params:{threadId:'thread',turn:{id:active,status:'completed'}}});
      active = null;
    }
    return;
  }
  if (f.method === 'turn/interrupt') {
    send({id:f.id,result:{}});
    send({method:'turn/completed',params:{threadId:'thread',turn:{id:active,status:'interrupted'}}});
    active = null;
    return;
  }
  send({id:f.id,result:{data:[]}});
});
`,
    { mode: 0o755 }
  )
  writeFileSync(
    `${BIN}/sh`,
    `#!/bin/sh\nexport PATH='${BIN}':"$PATH"\n[ "$1" = '-l' ] && shift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 }
  )

  let app
  try {
    const modulePath = `${ROOT}/scenario.mjs`
    await build({
      entryPoints: [path.join(REPO, 'tests/e2e/fixtures/busy-chat-registry.mjs')],
      outfile: modulePath,
      bundle: true,
      platform: 'node',
      format: 'esm'
    })
    const { loadBusyChatRegistry } = await import(pathToFileURL(modulePath).href)
    const receipt = await loadBusyChatRegistry(async (runId) => {
      const launched = await launchApp(DIR, {
        server: 'in-process',
        env: { SHELL: `${BIN}/sh`, PATH: `${BIN}:${process.env.PATH}` }
      })
      app = launched.app
      const opened = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'codex',
        chat: true,
        account: 'default',
        workspace: 'followup',
        name: `Follow-up ${runId}`
      })
      assert.ok(opened?.sessionId, 'fixture must create a Codex chat')
      return { win: launched.win, sessionId: opened.sessionId, close: () => app.close() }
    }, 'codex/active-turn-input')
    const { win, sessionId } = receipt.values.chat
    console.log(
      JSON.stringify({
        scenario: 'codex/active-turn-input',
        runId: receipt.runId,
        sessionId,
        root: ROOT
      })
    )
    const view = win.locator(
      `section.chat-host[data-session-id="${sessionId}"] [data-testid="chat-view"]`
    )
    const input = view.getByRole('textbox', { name: 'Message', exact: true })
    await input.waitFor()

    await check('a working Codex turn accepts a follow-up using the Send button', async () => {
      await input.fill('first message')
      await input.press('Enter')
      await view.getByRole('button', { name: 'Interrupt', exact: true }).waitFor()
      await input.fill('follow-up by button')
      await view.getByRole('button', { name: 'Send message', exact: true }).click()
      await waitFor(async () =>
        (await view.textContent()).includes('Received: follow-up by button')
      )
      assert.equal(requests().filter((f) => f.method === 'turn/start').length, 1)
      assert.equal(requests().filter((f) => f.method === 'turn/interrupt').length, 0)
      const steer = requests().find((f) => f.method === 'turn/steer')
      assert.equal(steer.params.expectedTurnId, 'turn-1')
      assert.equal(await input.inputValue(), '')
    })
    await check('Enter sends another follow-up and delivery rejection is visible', async () => {
      await input.fill('follow-up by Enter')
      await input.press('Enter')
      await waitFor(async () => (await view.textContent()).includes('Received: follow-up by Enter'))
      await input.fill('reject this message')
      await input.press('Enter')
      await waitFor(async () => (await view.textContent()).includes('Fixture rejected follow-up'))
      assert.equal(requests().filter((f) => f.method === 'turn/start').length, 1)
    })
    await check(
      'a completed turn permits an idle send and Interrupt remains available',
      async () => {
        await input.fill('finish this turn')
        await input.press('Enter')
        await waitFor(async () => (await view.textContent()).includes('Received: finish this turn'))
        await view.getByRole('button', { name: 'Send message', exact: true }).waitFor()
        await input.fill('new turn')
        await input.press('Enter')
        const stop = view.getByRole('button', { name: 'Interrupt', exact: true })
        await stop.waitFor()
        await stop.click()
        await waitFor(() => requests().filter((f) => f.method === 'turn/interrupt').length === 1)
        assert.equal(requests().filter((f) => f.method === 'turn/start').length, 2)
        assert.equal(requests().filter((f) => f.method === 'turn/steer').length, 4)
      }
    )
    await check(
      'the Terminal view sends follow-ups and Escape interrupts with a draft',
      async () => {
        const opened = await callMcp(app, 'openSession', {
          cwd: ROOT,
          mode: 'codex',
          chat: true,
          account: 'default',
          workspace: 'followup',
          name: 'Terminal follow-up'
        })
        assert.ok(opened?.sessionId)
        await win.evaluate(
          (id) => window.electronAPI.sessionsSetView(id, 'clave.chat-view/terminal'),
          opened.sessionId
        )
        const terminal = win.locator(
          `section.chat-host[data-session-id="${opened.sessionId}"] [data-testid="terminal-view"]`
        )
        const message = terminal.getByRole('textbox', { name: 'Message', exact: true })
        await message.waitFor()
        await message.fill('terminal first')
        await message.press('Enter')
        await terminal.getByRole('button', { name: 'Interrupt', exact: true }).waitFor()
        await message.fill('terminal follow-up')
        await terminal.getByRole('button', { name: 'Send message', exact: true }).click()
        await waitFor(async () =>
          (await terminal.textContent()).includes('Received: terminal follow-up')
        )
        await message.fill('keep this draft')
        await message.press('Escape')
        await waitFor(() => requests().filter((f) => f.method === 'turn/interrupt').length === 2)
        assert.equal(await message.inputValue(), 'keep this draft')
        assert.equal(requests().filter((f) => f.method === 'turn/start').length, 3)
      }
    )
  } finally {
    if (app) await app.close()
  }
}
