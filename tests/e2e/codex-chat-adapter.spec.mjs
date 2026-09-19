import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { REPO, seedWorkspaces, seedTrustedRoots, until } from './harness.mjs'

const ROOT = `/tmp/clave-e2e-codex-chat-${process.pid}`
const DIR = `${ROOT}/data`
const BIN = `${ROOT}/bin`
const LOG = `${ROOT}/rpc.ndjson`
const ENTRY = path.join(REPO, `out/main/.codex-e2e-${process.pid}.cjs`)

// A real executable over real pipes; every conversation frame comes from the
// checked-in live capture. No installed CLI or real auth is reachable here.
function seedStub() {
  mkdirSync(BIN, { recursive: true })
  const fixture = path.join(REPO, 'src/main/sessions/fixtures/codex-app-server/live.ndjson')
  writeFileSync(
    `${BIN}/codex`,
    `#!${process.execPath}
const fs = require('node:fs');
const rows = fs.readFileSync(${JSON.stringify(fixture)}, 'utf8').trim().split('\\n').map(JSON.parse);
const send = f => process.stdout.write(JSON.stringify(f) + '\\n');
let count = 0, paused = [], active;
function replay(frames) {
  while (frames.length) {
    const f = frames.shift(); send(f);
    if (f.method && f.id !== undefined) { paused = frames; return; }
  }
}
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const f = JSON.parse(line); fs.appendFileSync(${JSON.stringify(LOG)}, line+'\\n');
  if (!f.method) {
    if (f.result?.decision !== 'cancel') { process.stderr.write('Wrong approval decision'); process.exit(9); }
    replay(paused); paused=[]; return;
  }
  if (f.method === 'initialize') send({id:f.id,result:{userAgent:'codex-stub/0.154.0'}});
  else if (f.method === 'initialized') return;
  else if (f.method === 'thread/start' || f.method === 'thread/resume') {
    const response=rows.find(r => r.direction==='server' && r.frame.id===2 && r.frame.result).frame.result;
    send({id:f.id,result:response});
    send(rows.find(r=>r.frame.method==='thread/started').frame);
  } else if (f.method === 'turn/start') {
    active=['turn-hello','turn-approval','turn-interrupt'][count++];
    const frames=rows.filter(r=>r.direction==='server' && r.frame.method && (r.frame.params?.turnId===active || r.frame.params?.turn?.id===active)).map(r=>r.frame);
    send({id:f.id,result:{turn:{id:active,status:'inProgress'}}});
    replay(active==='turn-interrupt' ? frames.filter(f=>f.method!=='turn/completed') : frames);
  } else if (f.method === 'turn/interrupt') {
    if (f.params.threadId!=='thread-recorded' || f.params.turnId!==active) process.exit(10);
    send({id:f.id,result:{}});
    send(rows.find(r=>r.frame.method==='turn/completed' && r.frame.params.turn.id===active).frame);
  } else send({id:f.id,error:{code:-32601,message:'Unexpected method: '+f.method}});
});
`,
    { mode: 0o755 }
  )
  // Exercise the login-shell launch, but keep the fixture PATH first even when
  // the machine's login profile would reorder it. This shell is fixture-owned.
  writeFileSync(
    `${BIN}/sh`,
    `#!/bin/sh\nexport PATH='${BIN}':"$PATH"\n[ "$1" = '-l' ] && shift\nexec /bin/sh "$@"\n`,
    { mode: 0o755 }
  )
}

export async function run(t) {
  seedStub()
  const workspace = {
    id: 'codex-chat',
    name: 'Codex chat',
    rootDir: ROOT,
    profileFile: null,
    createdAt: 1
  }
  seedWorkspaces(DIR, { workspaces: [workspace], activeWorkspaceId: workspace.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  let app
  try {
    // Expose the *same* bundled singleton used by the real IPC handlers. The
    // temporary entry adds only a test reference; no production source, IPC,
    // adapter implementation, or renderer is replaced. Fail if bundling changes.
    const built = readFileSync(path.join(REPO, 'out/main/index.js'), 'utf8')
    assert.match(built, /const sessionManager = new SessionManager\(/)
    assert.match(built, /const windowRegistry = new WindowRegistry\(/)
    writeFileSync(
      ENTRY,
      built + '\nglobalThis.__codexAdapterTest = { sessionManager, windowRegistry };\n'
    )
    app = await electron.launch({
      executablePath: path.join(
        REPO,
        'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      ),
      args: [ENTRY, `--user-data-dir=${DIR}`, '--test-no-activate'],
      cwd: REPO,
      env: { ...process.env, SHELL: `${BIN}/sh`, PATH: `${BIN}:${process.env.PATH}` }
    })
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const record = await app.evaluate(async ({ BrowserWindow }, cwd) => {
      const { sessionManager, windowRegistry } = globalThis.__codexAdapterTest
      const win = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0]
      const windowKey = windowRegistry.getKeyForWindow(win.id)
      if (!windowKey) throw new Error('Real window registry has no window key')
      return sessionManager.create({
        id: 'codex-replay',
        provider: 'codex',
        transport: 'events',
        adapterId: 'codex-chat',
        cwd,
        windowKey,
        state: 'idle',
        title: 'Codex fixture',
        createdAt: Date.now()
      })
    }, ROOT)
    assert.equal(record.transport, 'events')
    assert.equal(record.provider, 'codex')
    t.check('registered adapter creates a real events session in sessionManager', true)
    await win.evaluate(async (id) => {
      window.__codexFrames = []
      window.__codexExit = null
      window.__codexOff = window.electronAPI.onSessionStream(id, (value) =>
        window.__codexFrames.push(value.event)
      )
      window.electronAPI.onSessionStreamExit(id, (code) => {
        window.__codexExit = code
      })
      await window.electronAPI.sessionsSubscribe(id)
    }, record.id)
    const write = (input) =>
      win.evaluate(({ id, input }) => window.electronAPI.sessionsWrite(id, input), {
        id: record.id,
        input
      })
    const frames = () => win.evaluate(() => window.__codexFrames)
    const doneCount = async () =>
      (await frames()).filter((e) => e.type === 'state_change' && e.state === 'done').length
    await write({ type: 'user_message', text: 'hello' })
    assert.ok(await until(async () => (await doneCount()) === 1), 'First turn must finish')
    let events = await frames()
    assert.equal(events[0].type, 'user_message')
    assert.ok(
      events.some((e) => e.type === 'session_meta' && e.providerSessionId === 'thread-recorded')
    )
    assert.equal(
      events.filter((e) => e.type === 'session_meta').length,
      1,
      'Startup metadata must not be duplicated'
    )
    const firstFinal = events.findIndex((e) => e.type === 'assistant_text' && e.final)
    const firstDone = events.findIndex((e) => e.type === 'state_change' && e.state === 'done')
    assert.ok(
      firstFinal > 0 && firstFinal < firstDone,
      'Final assistant event must precede done (mutation sentinel)'
    )
    assert.equal(
      events
        .filter((e) => e.type === 'assistant_text')
        .map((e) => e.delta)
        .join(''),
      'Clave protocol ready.'
    )
    t.check('renderer receives metadata, streamed text and final before done in order', true)

    await write({ type: 'user_message', text: 'approval' })
    const approval = await until(async () =>
      (await frames()).find((e) => e.type === 'permission_request')
    )
    assert.ok(approval, 'Recorded command approval reaches renderer')
    assert.ok(approval.options.some((o) => o.id === 'cancel'))
    assert.ok(
      await until(
        async () =>
          (await win.evaluate(() => window.electronAPI.sessionsList())).find(
            (s) => s.id === record.id
          )?.state === 'blocked'
      )
    )
    t.check('protocol approval blocks the session observed through renderer IPC', true)
    await assert.rejects(
      () => write({ type: 'permission_response', id: approval.id, optionId: 'forged' }),
      /approval option/
    )
    await write({ type: 'permission_response', id: approval.id, optionId: 'cancel' })
    assert.ok(
      await until(async () => (await doneCount()) === 2),
      'Approval answer must release the turn'
    )
    const requests = readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(
      requests.some((f) => f.id === 0 && f.result?.decision === 'cancel'),
      'Stub must receive renderer decision with the original server id'
    )
    events = await frames()
    const tool = events.find((e) => e.type === 'tool_call')
    assert.ok(tool && events.some((e) => e.type === 'tool_result' && e.id === tool.id))
    t.check('approval round trip preserves decision, request id, and tool correlation', true)
    await write({ type: 'user_message', text: 'interrupt' })
    assert.ok(
      await until(
        async () =>
          (await win.evaluate(() => window.electronAPI.sessionsList())).find(
            (s) => s.id === record.id
          )?.state === 'working'
      )
    )
    await write({ type: 'interrupt' })
    assert.ok(
      await until(async () => (await doneCount()) === 3),
      'Interrupt must complete the turn'
    )
    assert.ok(readFileSync(LOG, 'utf8').includes('turn/interrupt'))
    t.check('renderer interrupt reaches the live stdio connection', true)
    await app.evaluate(
      async (_electron, id) => globalThis.__codexAdapterTest.sessionManager.kill(id),
      record.id
    )
    assert.ok(
      await until(async () => (await win.evaluate(() => window.__codexExit)) !== null),
      'Close must deliver exit'
    )
    events = await frames()
    assert.equal(events.at(-1).state, 'ended')
    t.check('close delivers ended before exit and cleans up the process', true)
  } finally {
    if (app) await app.close()
    rmSync(ENTRY, { force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}
