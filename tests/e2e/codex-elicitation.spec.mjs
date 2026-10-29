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

// Real chat, session host, Codex adapter and stdio. Only the provider is a
// recording executable. No installed CLI or subscription account is called.
const ROOT = fixturePath('codex-elicitation')
const DIR = userDataDir('codex-elicitation-data')
const BIN = `${ROOT}/bin`
const LOG = `${ROOT}/rpc.ndjson`
const requests = () => readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

export async function run(t) {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(LOG, '')
  seedWorkspaces(DIR, {
    workspaces: [
      { id: 'elicitation', name: 'MCP approval', rootDir: ROOT, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'elicitation',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${BIN}/sh`,
    `#!/bin/sh\nexport PATH='${BIN}':"$PATH"\n[ "$1" = '-l' ] && shift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    `${BIN}/codex`,
    `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
let active, pending, expected;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const f = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(LOG)},line+'\\n');
  if (!f.method) {
    assert.equal(f.id,pending);
    assert.deepEqual(f.result,{action:expected,content:null,_meta:null});
    send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:active,itemId:active,delta:'MCP reply verified: '+expected}});
    send({method:'turn/completed',params:{threadId:'thread',turn:{id:active,status:'completed'}}});
    pending=null; return;
  }
  if (f.method==='initialized') return;
  if (f.method==='initialize') return send({id:f.id,result:{}});
  if (f.method==='thread/start') return send({id:f.id,result:{thread:{id:'thread'},model:'fixture-model'}});
  if (f.method==='turn/start') {
    const kind=f.params.input.find(i=>i.type==='text')?.text;
    active='turn-'+kind;
    pending=kind==='empty' ? 73 : kind;
    expected=kind==='empty' ? 'accept' : kind==='required' ? 'decline' : 'cancel';
    send({id:f.id,result:{turn:{id:active,status:'inProgress'}}});
    send({method:'turn/started',params:{threadId:'thread',turn:{id:active}}});
    const params={threadId:'thread',turnId:active,serverName:'clave_test',mode:'form',
      _meta:{tool_name:'clave_list',tool_params:{workspace:'all'}},
      message:'Allow the clave_test MCP server to run tool "clave_list"?',
      requestedSchema:{type:'object',properties:{}}};
    if(kind==='required') params.requestedSchema={type:'object',properties:{name:{type:'string'}},required:['name']};
    if(kind==='url') {params.mode='url';params.url='https://example.test/authorize';params.elicitationId='url-request';delete params.requestedSchema;}
    return send({id:pending,method:'mcpServer/elicitation/request',params});
  }
  send({id:f.id,result:{data:[]}});
});
`,
    { mode: 0o755 }
  )
  const { app, win } = await launchApp(DIR, {
    env: { SHELL: `${BIN}/sh`, PATH: `${BIN}:${process.env.PATH}` }
  })
  let sessionId
  try {
    const bundled = `${ROOT}/scenario.cjs`
    await build({
      entryPoints: [path.join(REPO, 'tests/e2e/codex-elicitation-fixture.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundled,
      logLevel: 'silent'
    })
    const { loadElicitationFixture } = await import(pathToFileURL(bundled).href)
    const report = await loadElicitationFixture((name) =>
      callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'codex',
        chat: true,
        account: 'default',
        name
      })
    )
    writeFileSync(`${ROOT}/receipt.json`, JSON.stringify(report, null, 2))
    console.log(`codex/empty-elicitation run ${report.runId}`)
    const id = report.values.chat.sessionId
    sessionId = id
    const view = win.locator('[data-testid="chat-view"]')
    const composer = view.locator('textarea:not(:disabled)')
    await composer.waitFor()
    for (const [kind, action] of [
      ['empty', 'accept'],
      ['required', 'decline'],
      ['url', 'cancel']
    ]) {
      await composer.fill(kind)
      await composer.press('Enter')
      const dock = view.locator('.chat-prompt[data-kind="permission"]')
      await dock.waitFor()
      const accept = dock.getByRole('button', { name: 'accept', exact: true })
      assert.equal(
        await accept.count(),
        kind === 'empty' ? 1 : 0,
        `${kind}: acceptance follows the schema`
      )
      assert.equal(await dock.getByRole('button', { name: 'decline', exact: true }).count(), 1)
      assert.equal(await dock.getByRole('button', { name: 'cancel', exact: true }).count(), 1)
      await dock.getByRole('button', { name: action, exact: true }).click()
      assert.ok(
        await until(() =>
          requests().some(
            (f) => f.id === (kind === 'empty' ? 73 : kind) && f.result?.action === action
          )
        )
      )
      assert.ok(
        await until(async () => (await view.innerText()).includes(`MCP reply verified: ${action}`))
      )
      assert.ok(
        await until(
          async () =>
            (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === id)
              ?.state === 'done'
        )
      )
      assert.equal(await dock.count(), 0, 'answered approval leaves the dock')
      t.check(
        `${kind}: real UI ${action} reaches Codex with its original id and the turn finishes`,
        true
      )
    }
    const reply = requests().find((f) => f.id === 73 && f.result)
    assert.deepEqual(reply.result, { action: 'accept', content: null, _meta: null })
    t.check('accept is once only, with no persistence metadata or fabricated form fields', true)
  } finally {
    if (sessionId) await callMcp(app, 'closeSession', { sessionId })
    await app.close()
    // Keep this run's receipt and recording for inspection. Cleanup is scoped
    // to ROOT and DIR printed by the harness, never the installed app's data.
  }
}
