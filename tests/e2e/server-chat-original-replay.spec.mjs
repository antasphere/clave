import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { observeDaemon } from './fixtures/fleet-http-observer.mjs'
import {
  REPO,
  callMcp,
  fixturePath,
  identityOf,
  launchApp,
  seedTrustedRoots,
  seedWorkspaces,
  startE2eServer,
  until,
  userDataDir,
  waitForBoot
} from './harness.mjs'

const ROOT = fixturePath('server-chat-discovery-root')
const DIR = userDataDir('server-chat-discovery')
const BIN = path.join(ROOT, 'bin')
const LOG = path.join(ROOT, 'rpc.jsonl')
const SHOWN = { id: 'discovery-shown', name: 'Shown', rootDir: path.join(ROOT, 'shown') }
const HIDDEN = { id: 'discovery-hidden', name: 'Hidden', rootDir: path.join(ROOT, 'hidden') }

function seed() {
  for (const dir of [BIN, SHOWN.rootDir, HIDDEN.rootDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(LOG, '')
  seedWorkspaces(DIR, {
    workspaces: [SHOWN, HIDDEN].map((w) => ({ ...w, profileFile: null, createdAt: 1 })),
    activeWorkspaceId: SHOWN.id,
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    path.join(BIN, 'codex'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.167.2'); process.exit(0); }
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
let thread;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const f = JSON.parse(line);
  if (!f.method) return;
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({pid:process.pid, method:f.method, params:f.params}) + '\\n');
  if (f.method === 'initialized') return;
  if (f.method === 'thread/start' || f.method === 'thread/resume') {
    thread = f.params.threadId || require('node:crypto').randomUUID();
    return send({id:f.id,result:{thread:{id:thread},model:'gpt-fixture'}});
  }
  if (f.method === 'turn/start') {
    const turnId = require('node:crypto').randomUUID();
    const prompt = f.params.input.filter(i => i.type === 'text').map(i => i.text).join('\\n');
    const record = (type, payload) => JSON.stringify({timestamp:new Date().toISOString(),type,payload});
    const completed = item => record('event_msg', {type:'item_completed',thread_id:thread,turn_id:turnId,item});
    fs.appendFileSync(path.join(${JSON.stringify(path.join(ROOT, 'rollouts'))}, 'rollout-2026-11-12T00-00-00-'+thread+'.jsonl'), [
      record('event_msg', {type:'task_started',turn_id:turnId}),
      completed({type:'UserMessage',id:turnId+'-u',content:[{type:'text',text:prompt}]}),
      completed({type:'AgentMessage',id:turnId+'-a',content:[{type:'Text',text:'Fixture reply: '+prompt}]})
    ].join('\\n')+'\\n');
    send({id:f.id,result:{turn:{id:turnId,status:'inProgress'}}});
    send({method:'turn/started',params:{threadId:thread,turn:{id:turnId}}});
    send({method:'item/completed',params:{threadId:thread,turnId,item:{type:'agentMessage',id:turnId+'-a',text:'Fixture reply: '+prompt}}});
    return send({method:'turn/completed',params:{threadId:thread,turn:{id:turnId,status:'completed'}}});
  }
  send({id:f.id,result:f.method === 'model/list' ? {data:[]} : {}});
});
`,
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(BIN, 'claude'),
    '#!/bin/sh\n[ "$1" = "--version" ] && echo "2.1.0 fixture"\nexit 0\n',
    { mode: 0o755 }
  )
  writeFileSync(
    path.join(BIN, 'sh'),
    `#!/bin/sh\nexport PATH='${BIN}':"$PATH"\n[ "$1" = '-l' ] && shift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 }
  )
}

const requests = () => readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

export async function run(t) {
  seed()
  const env = {
    SHELL: path.join(BIN, 'sh'),
    PATH: `${BIN}:${process.env.PATH}`,
    CLAVE_CODEX_ROOT: path.join(ROOT, 'rollouts')
  }
  mkdirSync(env.CLAVE_CODEX_ROOT, { recursive: true })
  const server = await startE2eServer('server-chat-original-replay', {
    seedFrom: DIR,
    env,
    args: ['--test-no-activate']
  })
  const observer = await observeDaemon(server.url)
  const request = async (method, route, body) => {
    const response = await fetch(server.url + route, {
      method,
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    assert.ok(
      response.ok,
      `${method} ${route}: ${response.status} ${await response.clone().text()}`
    )
    return response.status === 204 ? null : response.json()
  }
  const record = (id) =>
    JSON.parse(readFileSync(path.join(server.dataDir, 'session-records', `${id}.json`), 'utf8'))
  let app
  try {
    // Establish the desktop's supported MCP announcement before any provider starts.
    const initial = await launchApp(DIR, {
      server: { url: observer.url, token: server.token },
      env
    })
    app = initial.app
    await app.close()
    app = null
    // The original conversation and its real provider turn precede attachment.
    const text = 'original message before desktop attachment'
    const reply = 'Fixture reply: ' + text
    const bundle = path.join(ROOT, 'original-scenario.cjs')
    await build({
      entryPoints: [path.join(REPO, 'tests/e2e/server-chat-discovery-fixture.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      logLevel: 'silent'
    })
    const { loadServerChatFixture } = await import(pathToFileURL(bundle).href)
    let original
    const receipt = await loadServerChatFixture(
      async (name) => {
        original = await request('POST', '/sessions/start', {
          cwd: HIDDEN.rootDir,
          options: { codexMode: true, launchProfileId: 'codex-chat', workspaceId: HIDDEN.id }
        })
        await request('POST', '/sessions/rename', { id: original.id, name })
        await request('POST', '/sessions/write', {
          id: original.id,
          input: { type: 'user_message', text }
        })
        return { id: original.id }
      },
      async () => {
        assert.ok(
          await until(
            async () =>
              (await request('GET', '/sessions')).find((s) => s.id === original.id)?.state ===
              'done'
          )
        )
        const page = await request('GET', `/sessions/timeline?id=${original.id}`)
        assert.ok(
          page.items.some((i) => i.event.delta === reply),
          'provider turn is queryable before desktop attachment'
        )
      }
    )
    writeFileSync(path.join(ROOT, 'original-replay-receipt.json'), JSON.stringify(receipt, null, 2))
    const before = record(original.id)
    assert.ok(before.codexThreadId)
    const transcript = path.join(
      env.CLAVE_CODEX_ROOT,
      `rollout-2026-11-12T00-00-00-${before.codexThreadId}.jsonl`
    )
    assert.ok(readFileSync(transcript, 'utf8').includes(reply))
    const providerPids = () => [
      ...new Set(
        requests()
          .filter((r) => r.params?.threadId === before.codexThreadId)
          .map((r) => r.pid)
      )
    ]
    const originalPids = providerPids()
    assert.equal(originalPids.length, 1)
    const late = await request('GET', `/sessions/history?id=${original.id}`)
    const attached = await launchApp(DIR, {
      server: { url: observer.url, token: server.token },
      env
    })
    app = attached.app
    const win = attached.win
    const listed = await until(
      async () => {
        const v = await callMcp(app, 'list', { workspace: 'all' })
        return v.sessions.some((s) => s.id === original.id) ? v : null
      },
      { tries: 40, gapMs: 200 }
    )
    assert.ok(listed, 'original session becomes a desktop row')
    assert.equal(listed.sessions.filter((s) => s.id === original.id).length, 1)
    await callMcp(app, 'switchWorkspace', { workspace: HIDDEN.id })
    assert.ok(await until(async () => (await identityOf(win)).workspaceId === HIDDEN.id))
    await win.locator(`[data-sidebar-item-id="${original.id}"]`).click()
    const chat = win.locator(`[data-session-id="${original.id}"] [data-testid="chat-view"]`)
    await chat.waitFor()
    const oldVisible = Boolean(
      await until(
        async () =>
          chat
            .getByText(reply, { exact: true })
            .isVisible()
            .catch(() => false),
        { tries: 40, gapMs: 200 }
      )
    )
    const proof = {
      code: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
      dirtySource: Boolean(
        execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim()
      ),
      scenario: 'desktop/server-chat-discovery',
      runId: receipt.runId,
      originalSessionId: original.id,
      originalProviderThread: before.codexThreadId,
      originalProviderPids: originalPids,
      providerTranscriptContainsOriginalReply: true,
      lateHistoryContainsOriginalReply: late.items.some((i) => i.event.delta === reply),
      desktopOriginalRowVisible: true,
      desktopOriginalReplyVisible: oldVisible,
      desktopChatText: await chat.innerText()
    }
    writeFileSync(path.join(ROOT, 'original-replay-ui-proof.json'), JSON.stringify(proof, null, 2))
    t.check(
      'the original pre-attachment reply is visible in the original desktop conversation',
      oldVisible,
      proof
    )
    assert.equal(
      await chat.getByText(reply, { exact: true }).count(),
      1,
      'the earlier reply renders once'
    )
    const composer = chat.locator('textarea:not(:disabled)')
    await composer.fill('continuation after desktop reconnect')
    await composer.press('Enter')
    await chat
      .getByText('Fixture reply: continuation after desktop reconnect', { exact: true })
      .waitFor()

    // Cut only the desktop's real push sockets. The provider and its server
    // keep running, and HTTP lets the fixture produce genuinely missed turns.
    observer.pausePush()
    const missed = 'missed while desktop push was disconnected'
    await request('POST', '/sessions/write', {
      id: original.id,
      input: { type: 'user_message', text: missed }
    })
    assert.ok(
      await until(
        async () =>
          (await request('GET', '/sessions')).find((s) => s.id === original.id)?.state === 'done'
      )
    )
    assert.equal(await chat.getByText('Fixture reply: ' + missed, { exact: true }).count(), 0)
    const connections = observer.pushConnections
    observer.resumePush()
    assert.ok(await until(() => observer.pushConnections > connections, { tries: 60, gapMs: 200 }))
    await chat.getByText('Fixture reply: ' + missed, { exact: true }).waitFor()
    assert.equal(await chat.getByText(reply, { exact: true }).count(), 1)
    assert.equal(await chat.getByText('Fixture reply: ' + missed, { exact: true }).count(), 1)
    proof.livePushReconnectRecovered = true
    t.check(
      'a real push reconnect recovers missed turns once without replacing the original provider',
      true
    )

    // Hold a real snapshot response after the server took its watermark,
    // then deliver two identical turns over the subscribed live channel.
    const held = observer.holdReply(
      (method, route) => method === 'GET' && route === '/sessions/timeline'
    )
    await win.reload()
    await waitForBoot(win)
    await win.locator(`[data-sidebar-item-id="${original.id}"]`).click()
    assert.ok(await until(() => held.taken), 'the timeline snapshot response is held')
    const overlap = 'identical turn during snapshot handoff'
    for (let i = 0; i < 2; i++) {
      await request('POST', '/sessions/write', {
        id: original.id,
        input: { type: 'user_message', text: overlap }
      })
      assert.ok(
        await until(
          async () =>
            (await request('GET', '/sessions')).find((s) => s.id === original.id)?.state === 'done'
        )
      )
    }
    held.release()
    const restored = win.locator(`[data-session-id="${original.id}"] [data-testid="chat-view"]`)
    await restored.getByText(reply, { exact: true }).waitFor()
    await restored
      .getByText('Fixture reply: continuation after desktop reconnect', { exact: true })
      .waitFor()
    assert.equal(await restored.getByText(reply, { exact: true }).count(), 1)
    assert.equal(
      await restored
        .getByText('Fixture reply: continuation after desktop reconnect', { exact: true })
        .count(),
      1
    )
    assert.ok(
      await until(
        async () =>
          (await restored.getByText('Fixture reply: ' + overlap, { exact: true }).count()) === 2
      )
    )
    assert.equal(await restored.getByText(overlap, { exact: true }).count(), 2)
    assert.equal(await restored.getByText('Fixture reply: ' + missed, { exact: true }).count(), 1)
    proof.snapshotLiveHandoffPreservedDistinctIdenticalTurns = true
    t.check(
      'frames arriving during a held snapshot render in order, with two identical turns kept distinct',
      true
    )
    t.check('reload recovers both original turns once without a replacement session', true)
    assert.equal(record(original.id).codexThreadId, before.codexThreadId)
    assert.deepEqual(providerPids(), originalPids)
    proof.newReplyVisible = true
    proof.providerIdentityPreserved = true
    proof.proofPath = path.join(ROOT, 'original-replay-ui-proof.json')
    writeFileSync(proof.proofPath, JSON.stringify(proof, null, 2))
    console.log('original replay UI proof: ' + JSON.stringify(proof))
    t.check(
      'new messages stream through the same original session, conversation and provider process',
      true
    )
  } finally {
    await app?.close()
    await observer.close()
    await server.stop()
  }
}
