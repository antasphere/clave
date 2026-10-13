/** Real hidden Electron, two app-server stub processes and the real Clave MCP
 * endpoint. The stub performs authenticated tools/list and caller/group tools,
 * without a provider turn. All executables and data belong to this run. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath,
  mcpHttpClient,
  mcpEndpoint,
  toolPayload
} from './harness.mjs'

const DIR = userDataDir('codex-chat-clave-tools')
const ROOT = fixturePath('codex-chat-clave-tools-root')
const BIN = path.join(ROOT, 'bin')
const LOG = path.join(ROOT, 'behavior.jsonl')
const ROLLOUTS = path.join(ROOT, 'rollouts')
const WS = {
  id: 'codex-tools-workspace',
  name: 'Codex tools fixture',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const snapshots = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []

function seedStub() {
  mkdirSync(BIN, { recursive: true })
  mkdirSync(ROLLOUTS, { recursive: true })
  writeFileSync(path.join(ROLLOUTS, 'rollout-2026-10-13T10-00-00-fixture-saved-thread.jsonl'), '')
  writeFileSync(
    path.join(BIN, 'sh'),
    `#!/bin/sh\nexport PATH='${BIN}':"$PATH"\nexport CLAVE_SESSION_ID=wrong CLAVE_CODEX_MCP_TOKEN=wrong\n[ "$1" = '-l' ] && shift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(BIN, 'codex'),
    `#!${process.execPath}
const fs = require('node:fs');
let thread, endpoint, token;
const send = f => process.stdout.write(JSON.stringify(f)+'\\n');
let rpcId = 0;
async function post(method, params) {
  const response = await fetch(endpoint, {
    method:'POST', headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token},
    body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params}), signal:AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Fixture Clave MCP HTTP '+response.status);
  const body = await response.text();
  const lines = body.split('\\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim());
  const rpc = JSON.parse(lines.length ? lines.at(-1) : body);
  if (rpc.error || rpc.result?.isError) throw new Error('Fixture Clave MCP tool failed '+JSON.stringify(rpc.error || rpc.result.content));
  return rpc.result;
}
async function tool(name,args) {
  const result = await post('tools/call',{name,arguments:args});
  return result.structuredContent || JSON.parse(result.content.find(c=>c.type==='text').text);
}
require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialized') return;
  try {
    if (frame.method === 'initialize') return send({id:frame.id,result:{userAgent:'fixture-only'}});
    if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
      const binding = Object.entries(frame.params.config || {}).find(([key])=>/^mcp_servers\\.clave_[a-f0-9]{12}$/.test(key));
      const cfg = binding?.[1];
      if (!cfg || !process.env.CLAVE_SESSION_ID || !process.env[cfg.bearer_token_env_var]) throw new Error('No per-tab Clave binding');
      endpoint=cfg.url; token=process.env[cfg.bearer_token_env_var];
      await post('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'clave-codex-fixture',version:'1'}});
      const tools = await post('tools/list',{});
      const before = await tool('clave_list',{});
      if (before.callerSessionId !== process.env.CLAVE_SESSION_ID) throw new Error('Wrong authenticated caller');
      const group = await tool('clave_create_group',{name:'Fixture '+process.env.CLAVE_SESSION_ID});
      await tool('clave_move_session',{sessionId:process.env.CLAVE_SESSION_ID,groupId:group.groupId});
      const after = await tool('clave_list',{});
      thread = frame.params.threadId || 'thread-'+process.env.CLAVE_SESSION_ID;
      fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({
        sessionId:process.env.CLAVE_SESSION_ID,method:frame.method,threadId:thread,
        callerSessionId:after.callerSessionId,callerGroupId:after.callerGroupId,
        groupId:group.groupId,tools:tools.tools.map(tool=>tool.name),
        members:after.groups.find(g=>g.id===group.groupId)?.sessionIds,
        tokenOnArgv:process.argv.some(arg=>arg.includes(token))
      })+'\\n');
      return send({id:frame.id,result:{thread:{id:thread},model:'fixture-model'}});
    }
    if (frame.method === 'turn/start') throw new Error('Provider turns forbidden');
    send({id:frame.id,result:{data:[]}});
  } catch (error) { fs.appendFileSync(${JSON.stringify(LOG)},JSON.stringify({method:frame.method,error:error.message,sessionId:process.env.CLAVE_SESSION_ID})+'\\n'); send({id:frame.id,error:{code:-32000,message:error.message}}); }
});
`,
    { mode: 0o755 }
  )
}

export async function run(t) {
  seedStub()
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win, server, fixture } = await launchApp(DIR, {
    env: {
      SHELL: path.join(BIN, 'sh'),
      PATH: `${BIN}:${process.env.PATH}`,
      CLAVE_CODEX_ROOT: ROLLOUTS
    }
  })
  const ids = []
  try {
    const opened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'codex',
      chat: true,
      name: 'Fresh fixture'
    })
    assert.ok(opened?.sessionId)
    ids.push(opened.sessionId)
    // The MCP open tool has no resume argument. Decorate exactly the next
    // host command with the fixture thread, then let the real open tool adopt
    // it in the renderer before its view starts the provider.
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const start = host.start
      host.start = function (input) {
        host.start = start
        return start.call(host, {
          ...input,
          options: { ...input.options, resumeSessionId: 'fixture-saved-thread' }
        })
      }
    })
    const reopened = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'codex',
      chat: true,
      name: 'Resumed fixture'
    })
    const resumed = { id: reopened?.sessionId }
    assert.ok(resumed.id)
    ids.push(resumed.id)
    await Promise.all(
      ids.map((id) => win.evaluate((id) => window.electronAPI.sessionsModels(id), id))
    )
    const records = await until(() => (snapshots().length === 2 ? snapshots() : null))
    assert.ok(records, 'Both fixture providers must reach authenticated MCP behavior')
    for (const id of ids) {
      const record = records.find((record) => record.sessionId === id)
      assert.equal(record?.callerSessionId, id)
      assert.equal(record?.callerGroupId, record?.groupId)
      assert.deepEqual(record?.members, [id])
      assert.ok(record?.tools.includes('clave_open_session'))
      assert.ok(record?.tools.includes('clave_create_group'))
      assert.equal(record?.tokenOnArgv, false)
    }
    assert.equal(new Set(records.map((record) => record.groupId)).size, 2)
    assert.equal(records.find((record) => record.sessionId === resumed.id)?.method, 'thread/resume')
    t.check(
      'fresh and resumed Codex tabs discover real Clave tools and authenticate as distinct callers',
      true
    )
    t.check('each authenticated caller creates and joins its own real sidebar group', true)
    t.check('login profiles cannot overwrite tab identity or place the token on argv', true)

    // Read credentials privately to verify teardown on the real HTTP boundary.
    // They never enter assertion details, provider logs or the fixture receipt.
    const configDir = server?.dataDir ?? DIR
    const tokenOf = (id) =>
      JSON.parse(
        readFileSync(path.join(configDir, 'mcp-configs', id + '.json'), 'utf8')
      ).mcpServers.clave.headers.Authorization.slice(7)
    const ownToken = tokenOf(ids[0]),
      siblingToken = tokenOf(ids[1])
    const endpoint = mcpEndpoint(DIR)
    await callMcp(app, 'closeSession', { sessionId: ids[0] })
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    })
    assert.equal(response.status, 401)
    const sibling = mcpHttpClient(endpoint, siblingToken)
    await sibling.init()
    assert.equal(toolPayload(await sibling.call('clave_list', {})).callerSessionId, ids[1])
    t.check(
      'closing one Codex tab revokes its MCP auth while the sibling still authenticates',
      true
    )
    writeFileSync(
      path.join(ROOT, 'receipt.json'),
      JSON.stringify(
        {
          scenario: 'codex/authenticated-chat-tabs-electron',
          target: 'hidden-isolated-electron',
          sessions: ids,
          records
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(
      JSON.stringify({
        scenario: 'codex/authenticated-chat-tabs-electron',
        root: ROOT,
        sessions: ids
      })
    )
  } catch (error) {
    if (server)
      writeFileSync(
        path.join(ROOT, 'server-diagnostic.log'),
        server.stderr().replace(/[a-f0-9]{64}/g, '[redacted]'),
        { mode: 0o600 }
      )
    throw error
  } finally {
    for (const id of ids) await callMcp(app, 'closeSession', { sessionId: id }).catch(() => {})
    await app.close()
  }
}
