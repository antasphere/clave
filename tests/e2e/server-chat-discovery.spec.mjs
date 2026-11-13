import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  REPO,
  callMcp,
  fixturePath,
  identityOf,
  launchApp,
  openWindow,
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
  const server = await startE2eServer('server-chat-discovery', {
    seedFrom: DIR,
    env,
    args: ['--test-no-activate']
  })
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
  const completed = async (id) =>
    until(
      async () => (await request('GET', '/sessions')).find((s) => s.id === id)?.state === 'done'
    )
  let app
  try {
    const launched = await launchApp(DIR, {
      server: { url: server.url, token: server.token },
      env
    })
    app = launched.app
    const { win } = launched
    // The frozen launch past remains distinct from positioned history.
    // The provider creates this transcript through a real server turn;
    // no session record or application event is hand-seeded. The separate
    // original-replay spec keeps this exact chat alive through its UI proof.
    const earlier = await request('POST', '/sessions/start', {
      cwd: HIDDEN.rootDir,
      options: { codexMode: true, launchProfileId: 'codex-chat', workspaceId: HIDDEN.id }
    })
    await request('POST', '/sessions/write', {
      id: earlier.id,
      input: { type: 'user_message', text: 'created outside the desktop' }
    })
    assert.ok(await completed(earlier.id))
    const priorThread = record(earlier.id).codexThreadId
    const transcript = path.join(
      env.CLAVE_CODEX_ROOT,
      `rollout-2026-11-12T00-00-00-${priorThread}.jsonl`
    )
    assert.match(readFileSync(transcript, 'utf8'), /Fixture reply: created outside the desktop/)
    const lateHistory = await request('GET', `/sessions/history?id=${earlier.id}`)
    const replayed = lateHistory.items.some(
      (i) => i.event.delta === 'Fixture reply: created outside the desktop'
    )
    assert.equal(replayed, false, 'legacy history keeps the launch boundary')
    const timeline = await request('GET', `/sessions/timeline?id=${earlier.id}`)
    assert.ok(
      timeline.items.some((i) => i.event.delta === 'Fixture reply: created outside the desktop')
    )
    const gap = {
      contract: 'legacy launch history and the pinned #388 positioned timeline',
      legacyHistoryContainsReply: replayed,
      positionedTimelineContainsReply: true,
      providerTranscriptContainsReply: true,
      sessionId: earlier.id,
      threadId: priorThread
    }
    writeFileSync(path.join(ROOT, 'history-boundaries.json'), JSON.stringify(gap, null, 2))
    console.log(`history boundaries: ${JSON.stringify(gap)}`)
    t.check(
      'positioned history includes pre-attachment turns while legacy launch history stays frozen',
      true
    )
    assert.ok(
      await until(async () =>
        (await callMcp(app, 'list', { workspace: 'all' })).sessions.some((s) => s.id === earlier.id)
      )
    )
    await callMcp(app, 'closeSession', { sessionId: earlier.id })
    const beforeResumed = requests().length

    win.on('console', (message) => {
      if (message.type() === 'error') console.log('discovery renderer:', message.text())
    })
    win.on('pageerror', (error) => console.log('discovery page:', error.message))
    const desktop = await callMcp(app, 'openSession', {
      cwd: SHOWN.rootDir,
      mode: 'codex',
      profile: 'codex-chat',
      account: 'default'
    })
    assert.ok(desktop.sessionId)
    const before = await callMcp(app, 'list', { workspace: 'all' })
    const bundle = path.join(ROOT, 'scenario.cjs')
    await build({
      entryPoints: [path.join(REPO, 'tests/e2e/server-chat-discovery-fixture.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      logLevel: 'silent'
    })
    const { loadServerChatFixture } = await import(pathToFileURL(bundle).href)
    let id
    const report = await loadServerChatFixture(
      async (name) => {
        const info = await request('POST', '/sessions/start', {
          cwd: HIDDEN.rootDir,
          options: {
            codexMode: true,
            launchProfileId: 'codex-chat',
            workspaceId: HIDDEN.id,
            resumeSessionId: priorThread
          }
        })
        id = info.id
        await request('POST', '/sessions/rename', { id, name })
        await request('POST', '/sessions/write', {
          id,
          input: { type: 'user_message', text: 'continuing the original conversation' }
        })
        return { id }
      },
      async () => {
        assert.ok((await request('GET', '/sessions')).some((s) => s.id === id))
        assert.ok(await completed(id))
        assert.ok(
          await until(async () => {
            const history = await request('GET', `/sessions/history?id=${id}`)
            return history.items.some(
              (i) => i.event.delta === 'Fixture reply: created outside the desktop'
            )
          }),
          'the fixture waits for its provider reply through the history query'
        )
      }
    )
    writeFileSync(path.join(ROOT, 'receipt.json'), JSON.stringify(report, null, 2))
    console.log(`desktop/server-chat-discovery run ${report.runId}, session ${id}`)
    const listed = await until(
      async () => {
        const all = await callMcp(app, 'list', { workspace: 'all' })
        return all.sessions.some((s) => s.id === id) ? all : null
      },
      { tries: 40, gapMs: 200 }
    )
    assert.ok(listed, 'a live windowless server chat is discovered without reloading the desktop')
    assert.equal(listed.sessions.filter((s) => s.id === id).length, 1)
    assert.equal(listed.sessions.find((s) => s.id === id).workspaceId, HIDDEN.id)
    assert.equal(listed.focusedSessionId, before.focusedSessionId)
    assert.equal(listed.activeWorkspaceId, before.activeWorkspaceId)
    const primary = await identityOf(win)
    const original = record(id)
    assert.equal(
      original.windowKey,
      primary.windowKey,
      'ownership is persisted on the original record'
    )
    assert.ok(original.codexThreadId, 'the original provider conversation was started')
    const history = await win.evaluate((id) => window.electronAPI.sessionsHistory(id), id)
    assert.ok(
      history.items.some((i) => i.event.delta === 'Fixture reply: created outside the desktop')
    )
    assert.equal(
      requests()
        .slice(beforeResumed)
        .filter((r) => r.method === 'turn/start').length,
      1
    )
    await callMcp(app, 'switchWorkspace', { workspace: HIDDEN.id })
    assert.ok(await until(async () => (await identityOf(win)).workspaceId === HIDDEN.id))
    await win.locator(`[data-sidebar-item-id="${id}"]`).click()
    await win.getByText('Fixture reply: created outside the desktop', { exact: true }).waitFor()
    const composer = win.locator(
      `[data-session-id="${id}"] [data-testid="chat-view"] textarea:not(:disabled)`
    )
    await composer.fill('after desktop adoption')
    await composer.press('Enter')
    await win.getByText('Fixture reply: after desktop adoption', { exact: true }).waitFor()
    t.check(
      'a discovered chat preserves resumed history and its original provider delivers ongoing messages',
      true
    )

    const group = await callMcp(app, 'createGroup', {
      name: 'Discovered chats',
      workspace: HIDDEN.id
    })
    await callMcp(app, 'moveSession', { sessionId: id, groupId: group.groupId })
    const organized = await callMcp(app, 'list', { workspace: 'all' })
    assert.ok(organized.groups.find((g) => g.id === group.groupId)?.sessionIds.includes(id))
    const read = await callMcp(app, 'readSession', {
      sessionId: id,
      callerSessionId: desktop.sessionId,
      lines: 10
    })
    assert.equal(read.sessionId, id, 'desktop tools read and organize the original ID')

    const second = await openWindow(app, win, HIDDEN.id)
    const secondIdentity = await identityOf(second.page)
    const secondaryChat = await callMcp(
      app,
      'openSession',
      { cwd: HIDDEN.rootDir, mode: 'codex', profile: 'codex-chat', account: 'default' },
      10_000,
      secondIdentity.windowId
    )
    assert.equal(record(secondaryChat.sessionId).windowKey, secondIdentity.windowKey)
    const dormant = await request('POST', '/sessions/start', {
      cwd: HIDDEN.rootDir,
      options: { codexMode: true, launchProfileId: 'codex-chat', workspaceId: HIDDEN.id }
    })
    const dormantArrived = await until(async () => {
      const all = await callMcp(app, 'list', { workspace: 'all' })
      return all.sessions.find((s) => s.id === dormant.id) ?? null
    })
    assert.ok(dormantArrived, 'registration discovers even a chat whose provider has not started')
    assert.equal(record(dormant.id).windowKey, primary.windowKey, 'the primary takes the orphan')
    assert.equal(
      record(dormant.id).codexThreadId,
      undefined,
      'discovery does not start a dormant provider'
    )
    const secondaryList = await callMcp(
      app,
      'list',
      { workspace: 'all' },
      10_000,
      secondIdentity.windowId
    )
    assert.ok(secondaryList.sessions.some((s) => s.id === secondaryChat.sessionId))
    assert.ok(!secondaryList.sessions.some((s) => s.id === id || s.id === dormant.id))
    assert.equal(record(secondaryChat.sessionId).windowKey, secondIdentity.windowKey)
    const primaryList = await callMcp(app, 'list', { workspace: 'all' })
    assert.ok(!primaryList.sessions.some((s) => s.id === secondaryChat.sessionId))
    t.check('the primary discovers dormant orphans without stealing another window’s chat', true)

    const originalTurns = () =>
      requests()
        .slice(beforeResumed)
        .filter((r) => r.params?.threadId === original.codexThreadId)
    const originalPids = [...new Set(originalTurns().map((r) => r.pid))]
    assert.equal(originalPids.length, 1)
    await win.reload()
    await waitForBoot(win)
    const restored = await until(async () => {
      const all = await callMcp(app, 'list', { workspace: 'all' })
      return all.sessions.some((s) => s.id === id) ? all : null
    })
    assert.ok(restored, 'the claimed session recovers on reload')
    assert.equal(restored.sessions.filter((s) => s.id === id).length, 1)
    assert.ok(restored.groups.find((g) => g.id === group.groupId)?.sessionIds.includes(id))
    assert.equal(record(id).codexThreadId, original.codexThreadId)
    assert.deepEqual([...new Set(originalTurns().map((r) => r.pid))], originalPids)
    assert.equal(originalTurns().filter((r) => r.method === 'turn/start').length, 2)
    const restoredHistory = await win.evaluate((id) => window.electronAPI.sessionsHistory(id), id)
    assert.equal(
      restoredHistory.items.filter(
        (i) => i.event.delta === 'Fixture reply: created outside the desktop'
      ).length,
      1
    )
    t.check(
      'reload retains the group, original provider process, conversation and single reply',
      true
    )

    await app.close()
    app = null
    const preexisting = await request('POST', '/sessions/start', {
      cwd: HIDDEN.rootDir,
      options: { codexMode: true, launchProfileId: 'codex-chat', workspaceId: HIDDEN.id }
    })
    const reopened = await launchApp(DIR, {
      server: { url: server.url, token: server.token },
      env
    })
    app = reopened.app
    const recovered = await until(async () => {
      const all = await callMcp(app, 'list', { workspace: 'all' })
      return all.sessions.some((s) => s.id === preexisting.id) ? all : null
    })
    assert.ok(recovered, 'an orphan created with no desktop attached is recovered on connect')
    assert.equal(recovered.sessions.filter((s) => s.id === preexisting.id).length, 1)
    assert.equal(recovered.sessions.filter((s) => s.id === id).length, 1)
    assert.equal(record(id).codexThreadId, original.codexThreadId)
    assert.deepEqual([...new Set(originalTurns().map((r) => r.pid))], originalPids)
    assert.equal(originalTurns().filter((r) => r.method === 'turn/start').length, 2)
    t.check(
      'desktop reconnect recovers preexisting orphans without restarting the original provider',
      true
    )
  } finally {
    await app?.close()
    await server.stop()
  }
}
