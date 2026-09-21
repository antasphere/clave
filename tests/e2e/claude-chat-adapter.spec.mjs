import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir
} from './harness.mjs'
const DIR = userDataDir('claude-chat-adapter')
const ROOT = '/tmp/clave-e2e-claude-chat-root'
const TOKEN = 'sk-ant-oat01-claude-chat-fixture-token-0123456789'
export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [{ id: 'chat-ws', name: 'Chat', rootDir: ROOT, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'chat-ws',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  // A login shell fixture preserves the stub-first PATH instead of the host's path_helper.
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const readline = require('node:readline');
const frames = fs.readFileSync(${JSON.stringify(path.join(REPO, 'src/main/sessions/fixtures/claude-stream/permission-turn.ndjson'))}, 'utf8').trim().split('\\n').map(JSON.parse);
process.on('SIGTERM',()=>{});
const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true, stdio:['ignore',process.stdout,process.stderr]});
grandchild.unref();
fs.appendFileSync(${JSON.stringify(`${ROOT}/descendants.jsonl`)}, JSON.stringify({pid:grandchild.pid})+'\\n');
const argv=process.argv.slice(2); const providerId=argv[argv.indexOf('--session-id')+1];
for(const frame of frames) if(frame.session_id) frame.session_id=providerId;
const split = frames.findIndex(f => f.type === 'control_request');
fs.writeFileSync(${JSON.stringify(`${ROOT}/process.json`)}, JSON.stringify({pid:process.pid, providerId, argv:process.argv.slice(2), token:process.env.CLAUDE_CODE_OAUTH_TOKEN, configDir:process.env.CLAUDE_CONFIG_DIR}));
function emit(f) { process.stdout.write(JSON.stringify(f)+'\\n'); }
readline.createInterface({input:process.stdin}).on('line', line => {
 fs.appendFileSync(${JSON.stringify(`${ROOT}/input.ndjson`)}, line+'\\n'); const input=JSON.parse(line);
 if(input.type==='user') { if(input.message.content==='configured first prompt') frames[0].session_id='provider-diverged'; emit(frames[0]); setTimeout(()=>frames.slice(1,split+1).forEach(emit),350); }
 if(input.type==='control_response') setTimeout(()=>frames.slice(split+1).forEach(emit),350);
});
setInterval(()=>{},1000);
`,
    { mode: 0o755 }
  )
  const { app, win } = await launchApp(DIR, {
    env: { SHELL: `${ROOT}/bin/bash`, PATH: `${ROOT}/bin:${process.env.PATH}` }
  })
  let closed = false
  try {
    // Create the account in main. Track all outbound IPC AFTER storing the token;
    // no renderer input or process-output payload is allowed to carry it.
    await app.evaluate(async ({ ipcMain, BrowserWindow }, token) => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ type: 'message', content: [] }), {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.1',
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
            'anthropic-ratelimit-unified-5h-status': 'allowed'
          }
        })
      const handlers = ipcMain._invokeHandlers
      const account = await handlers.get('claude-accounts:add')(
        {},
        { label: 'Fixture account', configDir: '/tmp/clave-chat-account' }
      )
      await handlers.get('claude-accounts:set-token')({}, account.id, token)
      const original = handlers.get('pty:spawn')
      handlers.set('pty:spawn', (event, cwd, options) =>
        original(event, cwd, {
          ...options,
          claudeProfileId: account.id,
          configDir: '/tmp/clave-chat-account'
        })
      )
      globalThis.__chatLeaks = []
      for (const win of BrowserWindow.getAllWindows()) {
        const send = win.webContents.send.bind(win.webContents)
        win.webContents.send = (channel, ...args) => {
          if (JSON.stringify(args).includes(token)) globalThis.__chatLeaks.push(channel)
          return send(channel, ...args)
        }
      }
      for (const [channel, handler] of handlers)
        handlers.set(channel, async (...args) => {
          const result = await handler(...args)
          if (JSON.stringify(result)?.includes(token)) globalThis.__chatLeaks.push(channel)
          return result
        })
    }, TOKEN)
    const profiles = await win.evaluate(() => window.electronAPI.launchProfilesList())
    assert.ok(
      profiles.customProfiles.some((p) => p.id === 'claude-chat' && p.name === 'Claude (chat)')
    )
    await win.evaluate(() => window.electronAPI.launchProfileSetGlobal('claude', 'claude-chat'))
    await win.reload()
    await win.locator('.launcher-split .launcher-btn').waitFor()
    await win.click('.launcher-split .launcher-btn')
    const session = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'claude-chat'
      )
    )
    assert.ok(session, 'launcher creates Claude events session')
    assert.equal(session.transport, 'events')
    await win.getByTestId('chat-view').waitFor()
    await win.evaluate(async (id) => {
      window.__chat = []
      window.__chatExit = null
      window.electronAPI.onSessionStream(id, (value) => window.__chat.push(value.event))
      window.electronAPI.onSessionStreamExit(id, (code) => {
        window.__chatExit = code
      })
      await window.electronAPI.sessionsSubscribe(id)
      await window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'fixture prompt' })
    }, session.id)
    assert.ok(
      await until(() => win.locator('.sidebar-tab-icon .text-status-working').count()),
      'working state reaches sidebar'
    )
    assert.ok(
      await until(() => win.locator('.sidebar-tab-icon .bg-status-waiting').count()),
      'blocked state reaches sidebar'
    )
    const request = await win.evaluate(() =>
      window.__chat.find((e) => e.type === 'permission_request')
    )
    assert.ok(request)
    assert.equal(request.toolName, 'Write')
    assert.ok(request.description.includes('Write'))
    assert.ok(request.options.some((o) => o.label.includes('acceptEdits')))
    writeFileSync(path.join(DIR, 'agent-state', `${session.id}.state`), 'idle')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(
      (await win.evaluate(() => window.electronAPI.sessionsList())).find((s) => s.id === session.id)
        .state,
      'blocked'
    )
    const processInfo = JSON.parse(readFileSync(`${ROOT}/process.json`, 'utf8'))
    assert.equal(processInfo.token, TOKEN)
    assert.equal(processInfo.configDir, '/tmp/clave-chat-account')
    assert.ok(processInfo.argv.includes('--settings'))
    assert.ok(processInfo.argv.includes('--session-id'))
    assert.ok(processInfo.argv.includes('--permission-prompt-tool'))
    assert.ok(processInfo.argv.includes('stdio'))
    // Answer through a separate IPC consumer, never the chat view action.
    await win.evaluate(
      ({ id, requestId }) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'permission_response',
          id: requestId,
          optionId: 'deny'
        }),
      { id: session.id, requestId: request.id }
    )
    assert.ok(
      await until(
        async () => {
          const record = (await win.evaluate(() => window.electronAPI.sessionsList())).find(
            (s) => s.id === session.id
          )
          return (
            record?.state === 'working' &&
            (await win.locator('.sidebar-tab-icon .text-status-working').count()) === 1 &&
            (await win.locator('.sidebar-tab-icon .bg-status-waiting').count()) === 0
          )
        },
        { gapMs: 25 }
      ),
      'an outside-view sessionsWrite answer clears the waiting dot while the kernel is working'
    )
    // The chat pane is the same record. Its header leaves blocked, the card says
    // the request was answered outside this view, and its buttons go dead: a
    // click would reach an adapter that has already dropped the id (PRDCT-2549).
    const card = win.locator('.chat-permission-card').first()
    await card.locator('.chat-permission-answer[data-answered="elsewhere"]').waitFor()
    assert.ok(
      await until(
        async () => (await win.locator('.chat-state[data-state="blocked"]').count()) === 0
      ),
      'the pane header leaves blocked when the kernel does'
    )
    const buttons = await card.getByRole('button').all()
    assert.ok(buttons.length > 0, 'the permission card still shows the options it offered')
    for (const button of buttons)
      assert.equal(
        await button.isDisabled(),
        true,
        'a request answered outside the view offers no live button'
      )
    assert.equal(
      await win.getByRole('alert').count(),
      0,
      'an outside answer raises no error card in the pane'
    )
    t.check('the chat pane follows the kernel after an outside-view answer', true)
    t.check('outside-view permission answer makes the sidebar follow kernel working state', true)
    assert.ok(
      await until(async () =>
        (await win.evaluate(() => window.__chat)).some(
          (e) => e.type === 'state_change' && e.state === 'done'
        )
      )
    )
    const events = await win.evaluate(() => window.__chat)
    assert.equal(events[0].type, 'user_message')
    assert.ok(
      events.findIndex((e) => e.type === 'session_meta') <
        events.findIndex((e) => e.type === 'permission_request')
    )
    const tool = events.find((e) => e.type === 'tool_call')
    const result = events.find((e) => e.type === 'tool_result' && e.id === tool?.id)
    assert.ok(result, 'tool_result must survive translation and correlate with tool_call')
    assert.deepEqual(
      events.filter((e) => e.type === 'state_change').map((e) => e.state),
      ['working', 'blocked', 'working', 'done']
    )
    assert.equal(
      await win.locator('.sidebar-tab-icon .bg-status-waiting').count(),
      0,
      'the waiting dot stays clear when the kernel finishes the external answer'
    )
    const inputs = readFileSync(`${ROOT}/input.ndjson`, 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(inputs[1].response.request_id, request.id)
    assert.equal(inputs[1].response.response.behavior, 'deny')
    const capture = readFileSync(path.join(DIR, 'exchange-capture/events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((e) => e.session?.sessionId === session.id)
    assert.ok(capture.some((e) => e.state === 'working'))
    assert.ok(capture.some((e) => e.state === 'blocked'))
    assert.ok(capture.some((e) => e.state === 'idle'))
    // The launch announces its model at ready (null: the CLI's default) and the
    // CLI's init frame names the real one; the capture carries the latest.
    const model = events.findLast((e) => e.type === 'session_meta').model
    for (const row of capture) {
      assert.equal(row.session.claudeSessionId, processInfo.providerId)
      assert.equal(row.session.model, model)
    }
    assert.deepEqual(await app.evaluate(() => globalThis.__chatLeaks), [])
    assert.ok(!JSON.stringify({ session, events }).includes(TOKEN))
    t.check(
      'launcher, stream order, permission round trip, sidebar, capture and token isolation',
      true
    )
    await bounded(
      callMcp(app, 'closeSession', { sessionId: session.id }),
      'tab close with inherited stdout'
    )
    assert.ok(
      await until(() => win.evaluate(() => window.__chatExit !== null)),
      'closing delivers exit'
    )
    assert.equal((await win.evaluate(() => window.__chat)).at(-1).state, 'ended')
    assert.throws(() => process.kill(processInfo.pid, 0), /ESRCH/, 'closing kills owned process')
    t.check('closing tab ends stream and kills process', true)
    const second = await win.evaluate(
      (root) =>
        window.electronAPI.spawnSession(root, {
          claudeMode: true,
          launchProfileId: 'claude-chat',
          initialPrompt: 'configured first prompt',
          initialCommand: 'echo must-not-run',
          autoExecute: true
        }),
      ROOT
    )
    await win.evaluate(async (id) => {
      window.__second = []
      window.electronAPI.onSessionStream(id, (value) => window.__second.push(value.event))
      await window.electronAPI.sessionsSubscribe(id)
      await window.electronAPI.sessionsSubscribe(id)
    }, second.id)
    assert.ok(
      await until(async () =>
        // The CLI's own meta (it names its session), not the launch announcement.
        (await win.evaluate(() => window.__second)).some(
          (e) => e.type === 'session_meta' && e.providerSessionId
        )
      )
    )
    const secondEvents = await win.evaluate(() => window.__second)
    assert.equal(secondEvents.filter((e) => e.type === 'user_message').length, 1)
    assert.equal(
      secondEvents.find((e) => e.type === 'user_message').text,
      'configured first prompt'
    )
    assert.ok(secondEvents.some((e) => e.type === 'error' && !e.fatal))
    const inputRows = readFileSync(`${ROOT}/input.ndjson`, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.equal(
      inputRows.filter((e) => e.type === 'user' && e.message.content === 'configured first prompt')
        .length,
      1
    )
    t.check('configured prompt starts once after listeners; shell commands report an error', true)
    assert.equal(
      secondEvents.find((e) => e.type === 'session_meta' && e.providerSessionId)
        .providerSessionId,
      'provider-diverged'
    )
    assert.ok(
      secondEvents.some(
        (e) => e.type === 'error' && !e.fatal && e.message.includes('keeping the launch identity')
      )
    )
    const secondRows = readFileSync(path.join(DIR, 'exchange-capture/events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((row) => row.session?.sessionId === second.id)
    assert.ok(secondRows.length)
    for (const row of secondRows) assert.equal(row.session.claudeSessionId, second.claudeSessionId)
    assert.notEqual(second.claudeSessionId, 'provider-diverged')
    const secondPid = JSON.parse(readFileSync(`${ROOT}/process.json`, 'utf8')).pid
    await bounded(app.close(), 'quit waits for killAll with inherited stdout')
    closed = true
    assert.throws(() => process.kill(secondPid, 0), /ESRCH/, 'quit waits for SIGKILL escalation')
    t.check(
      'killAll settles on quit with detached descendants holding stdout; minted identity survives divergence',
      true
    )
  } finally {
    // Only fixture descendants whose PIDs this test recorded are ours to kill.
    try {
      for (const line of readFileSync(`${ROOT}/descendants.jsonl`, 'utf8').trim().split('\n')) {
        try {
          process.kill(JSON.parse(line).pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') console.error('Fixture descendant cleanup failed', error)
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Fixture descendant inventory unreadable', error)
    }
    if (!closed) await app.close()
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded 4 seconds`)), 4000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
