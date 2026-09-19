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
const split = frames.findIndex(f => f.type === 'control_request');
fs.writeFileSync(${JSON.stringify(`${ROOT}/process.json`)}, JSON.stringify({pid:process.pid, argv:process.argv.slice(2), token:process.env.CLAUDE_CODE_OAUTH_TOKEN, configDir:process.env.CLAUDE_CONFIG_DIR}));
function emit(f) { process.stdout.write(JSON.stringify(f)+'\\n'); }
readline.createInterface({input:process.stdin}).on('line', line => {
 fs.appendFileSync(${JSON.stringify(`${ROOT}/input.ndjson`)}, line+'\\n'); const input=JSON.parse(line);
 if(input.type==='user') setTimeout(()=>frames.slice(0,split+1).forEach(emit),350);
 if(input.type==='control_response') setTimeout(()=>frames.slice(split+1).forEach(emit),350);
});
setInterval(()=>{},1000);
`,
    { mode: 0o755 }
  )
  const { app, win } = await launchApp(DIR, {
    env: { SHELL: `${ROOT}/bin/bash`, PATH: `${ROOT}/bin:${process.env.PATH}` }
  })
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
    assert.ok(!profiles.customProfiles.some((p) => p.id === 'codex-chat'))
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
    const processInfo = JSON.parse(readFileSync(`${ROOT}/process.json`, 'utf8'))
    assert.equal(processInfo.token, TOKEN)
    assert.equal(processInfo.configDir, '/tmp/clave-chat-account')
    assert.ok(processInfo.argv.includes('--settings'))
    assert.ok(processInfo.argv.includes('--session-id'))
    assert.ok(processInfo.argv.includes('--permission-prompt-tool'))
    assert.ok(processInfo.argv.includes('stdio'))
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
    assert.equal(await win.locator('.sidebar-tab-icon .bg-status-waiting').count(), 0)
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
    assert.deepEqual(await app.evaluate(() => globalThis.__chatLeaks), [])
    assert.ok(!JSON.stringify({ session, events }).includes(TOKEN))
    t.check(
      'launcher, stream order, permission round trip, sidebar, capture and token isolation',
      true
    )
    await callMcp(app, 'closeSession', { sessionId: session.id })
    assert.ok(
      await until(() => win.evaluate(() => window.__chatExit !== null)),
      'closing delivers exit'
    )
    assert.equal((await win.evaluate(() => window.__chat)).at(-1).state, 'ended')
    assert.throws(() => process.kill(processInfo.pid, 0), /ESRCH/, 'closing kills owned process')
    t.check('closing tab ends stream and kills process', true)
  } finally {
    await app.close()
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}
