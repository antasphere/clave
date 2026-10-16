// E owns desktop-consumer integration. F owns the fleet fixture and two-client suite.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  fixturePath,
  serverFixture,
  until,
  REPO
} from './harness.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const owned = (kind, owner, id) =>
  `clave-owner:${kind}:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`
const collision = '11111111-1111-4111-8111-111111111111'
// Keep title scheduling inside a one-shot recording fixture as well.
function seedTitleProfile(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const script = path.join(dir, 'title-fixture.cjs')
  writeFileSync(script, 'process.stdout.write("Desktop fixture title\\n")', { mode: 0o600 })
  writeFileSync(
    path.join(dir, 'agent-launch-profiles.json'),
    JSON.stringify({
      version: 1,
      customProfiles: [
        {
          id: 'desktop-title-fixture',
          name: 'Desktop title fixture',
          family: 'claude',
          command: [process.execPath, script],
          additionalArgs: []
        }
      ],
      globalDefaults: { claude: 'desktop-title-fixture' },
      workspaceOverrides: {}
    }),
    { mode: 0o600 }
  )
}
async function daemon(label, previous) {
  const dir = previous?.dir ?? fixturePath(`desktop-fleet-${label}-${Date.now()}`)
  const cwd = path.join(dir, 'repo')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true })
  const rolloutRoot = path.join(dir, 'recording-codex-rollouts')
  mkdirSync(rolloutRoot, { recursive: true, mode: 0o700 })
  if (!previous) seedTitleProfile(dir)
  let stderr = ''
  const child = spawn(
    process.execPath,
    [
      path.join(REPO, 'out/main/server-entry.js'),
      '--daemon',
      '--host',
      '127.0.0.1',
      '--port',
      String(previous?.port ?? 0),
      '--data-dir',
      dir,
      '--terminal-process',
      path.join(REPO, 'out/main/terminal-process.js'),
      '--node',
      process.execPath,
      '--test-no-activate',
      '--dev-echo-adapter'
    ],
    {
      cwd: REPO,
      env: { ...process.env, SHELL: '/bin/sh', CLAVE_CODEX_ROOT: rolloutRoot },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout.resume()
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString()
  })
  const endpoint = await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`Test daemon failed: ${stderr.slice(-1500)}`)
      try {
        const value = JSON.parse(readFileSync(path.join(dir, 'clave-server.json'), 'utf8'))
        return value.pid === child.pid ? value : null
      } catch {
        return null
      }
    },
    { tries: 100, gapMs: 150 }
  )
  if (!endpoint) {
    child.kill('SIGTERM')
    throw new Error('Isolated daemon did not become ready')
  }
  return {
    ...endpoint,
    cwd: realpathSync(cwd),
    dir: realpathSync(dir),
    fixture: serverFixture(endpoint.url, endpoint.token),
    async stop() {
      if (child.exitCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const result = await Promise.race([exited, sleep(12000).then(() => null)])
      if (!result) {
        child.kill('SIGKILL')
        await once(child, 'exit')
        throw new Error('Owned daemon exceeded shutdown deadline')
      }
    }
  }
}
async function post(server, route, body) {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  assert.equal(response.status, 200, `owning endpoint ${route}: ${await response.clone().text()}`)
  return response.json()
}
async function check(condition, message) {
  assert.ok(await condition(), message)
}
export async function run(t) {
  const servers = []
  let app
  const root = fixturePath(`desktop-fleet-mac-root-${Date.now()}`)
  const dir = fixturePath(`desktop-fleet-mac-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  seedTitleProfile(dir)
  seedWorkspaces(dir, {
    workspaces: [{ id: 'mac-only', name: 'Mac', rootDir: root, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'mac-only',
    fresh: true
  })
  seedTrustedRoots(dir, [root])
  try {
    let a = await daemon('a')
    servers.push(a)
    const b = await daemon('b')
    servers.push(b)
    const launched = await launchApp(dir, {
      server: 'in-process',
      env: { SHELL: '/bin/sh' },
      args: ['--dev-echo-adapter']
    })
    app = launched.app
    const win = launched.win
    const rendererErrors = []
    const documentImageRequests = []
    win.on('request', (request) => {
      if (request.url().includes('server-picture.png')) documentImageRequests.push(request.url())
    })
    win.on('pageerror', (error) => rendererErrors.push(error.message))
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible())
      ),
      false
    )
    await win.getByLabel('Manage Clave servers', { exact: true }).click()
    await win.getByLabel('Server name', { exact: true }).fill('VPS A')
    await win.getByLabel('Server address', { exact: true }).fill(a.url)
    await win.getByLabel('Server bearer token', { exact: true }).fill(a.token)
    await win.getByRole('button', { name: 'Add server', exact: true }).click()
    await check(
      () =>
        until(async () => (await win.evaluate(() => window.electronAPI.fleetList())).length === 1),
      'UI saves the first server'
    )
    assert.equal(await win.getByLabel('Server bearer token', { exact: true }).inputValue(), '')
    await win.getByRole('button', { name: 'Close', exact: true }).click()
    const savedA = (await win.evaluate(() => window.electronAPI.fleetList()))[0]
    const savedB = await win.evaluate(
      ({ name, url, token }) => window.electronAPI.fleetSave({ name, url, token }),
      { name: 'VPS B', url: b.url, token: b.token }
    )
    assert.equal('token' in savedA, false)
    assert.equal('token' in savedB, false)
    await win.evaluate(() => {
      globalThis.fleetStatus = {}
      window.electronAPI.onFleetStatus((s) => {
        globalThis.fleetStatus[s.serverId] = s.state
      })
    })
    await check(
      () =>
        until(() =>
          win.evaluate(
            (ids) => ids.every((id) => globalThis.fleetStatus[id] === 'connected'),
            [savedA.id, savedB.id]
          )
        ),
      'both servers connect'
    )
    // The empty server has an explicit creation path, using its own folder/profile data.
    await win.getByLabel('Manage Clave servers', { exact: true }).click()
    await win
      .locator(`[data-server-id="${savedB.id}"]`)
      .getByRole('button', { name: 'New session', exact: true })
      .click()
    await win.getByLabel('Server folder', { exact: true }).fill(b.cwd)
    await win.getByRole('button', { name: 'Start session', exact: true }).click()
    await check(
      () =>
        until(async () =>
          (
            await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedB.id)
          ).sessions.some((s) => s.provider === 'terminal')
        ),
      'first session starts on empty owner'
    )
    const terminal = (
      await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedB.id)
    ).sessions.find((s) => s.provider === 'terminal')
    const terminalWire = decodeURIComponent(terminal.id.split(':').at(-1))
    await win.locator(`[data-terminal-tile="${terminal.id}"] .xterm`).waitFor()
    await win.evaluate((id) => {
      globalThis.remoteTerminalBytes = ''
      window.electronAPI.onSessionData(id, (data) => {
        globalThis.remoteTerminalBytes += data
      })
    }, terminal.id)
    await check(
      () =>
        until(() =>
          win.evaluate(
            () =>
              globalThis.remoteTerminalBytes.split(String.fromCharCode(27) + 'c').join('').length >
              3
          )
        ),
      'selected remote terminal actually starts and emits shell output'
    )

    await win.evaluate(
      (id) =>
        window.electronAPI.writeSession(
          id,
          "printf 'OWNING_REMOTE_EFFECT\\n' > bridge-effect.txt\r"
        ),
      terminal.id
    )
    await check(
      () => until(async () => existsSync(path.join(b.cwd, 'bridge-effect.txt'))),
      'remote terminal produces a real owning-server effect'
    )
    assert.equal(
      readFileSync(path.join(b.cwd, 'bridge-effect.txt'), 'utf8'),
      'OWNING_REMOTE_EFFECT\n'
    )
    assert.equal(existsSync(path.join(a.cwd, 'bridge-effect.txt')), false)
    t.check(
      'empty remote server starts a real terminal through UI and executes only on its owner',
      true
    )

    for (const server of [a, b])
      await post(server, '/sessions/start', {
        cwd: server === a ? server.cwd.replace(/^\/private\/tmp\//, '/tmp/') : server.cwd,
        windowKey: 'unrelated-mac-key',
        options: {
          claudeMode: true,
          launchProfileId: 'dev-echo-adapter',
          adoptSessionId: collision
        }
      })
    const ka = owned('session', savedA.id, collision)
    const kb = owned('session', savedB.id, collision)
    await win.evaluate(
      (ids) => Promise.all(ids.map((id) => window.electronAPI.fleetSnapshot(id))),
      [savedA.id, savedB.id]
    )
    await win.locator(`[data-sidebar-item-id="${ka}"]`).waitFor()
    await win.locator(`[data-sidebar-item-id="${kb}"]`).waitFor()
    assert.equal(
      await win.locator(`[data-sidebar-item-id="${ka}"] [data-fleet-owner="${savedA.id}"]`).count(),
      1
    )
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    await win
      .locator(`[data-session-id="${ka}"] [data-testid="chat-view"] textarea:not(:disabled)`)
      .waitFor()
    await win
      .locator(`[data-session-id="${ka}"] [data-testid="chat-view"] textarea`)
      .fill('message only for server A')
    await win
      .locator(`[data-session-id="${ka}"] [data-testid="chat-view"]`)
      .getByRole('button', { name: 'Send message', exact: true })
      .click()
    await win
      .locator(`[data-session-id="${ka}"] .chat-turn[data-role="assistant"]`)
      .filter({ hasText: 'message only for server A' })
      .waitFor()
    const histories = await win.evaluate(
      (ids) => Promise.all(ids.map((id) => window.electronAPI.sessionsHistory(id))),
      [ka, kb]
    )

    assert.equal(JSON.stringify(histories[1]).includes('message only for server A'), false)
    t.check(
      'colliding IDs from unrelated server windows have distinct sidebar rows, panes and live turns',
      true
    )

    writeFileSync(path.join(a.cwd, 'notes.txt'), 'A initial')
    writeFileSync(path.join(b.cwd, 'notes.txt'), 'B initial')
    mkdirSync(path.join(a.cwd, 'uploads'), { recursive: true })
    writeFileSync(
      path.join(a.cwd, 'remote.md'),
      '# From server A\n![server picture](server-picture.png)'
    )
    const fileA = owned('file', savedA.id, a.cwd)
    const fileB = owned('file', savedB.id, b.cwd)
    const reads = await win.evaluate(
      (roots) => Promise.all(roots.map((r) => window.electronAPI.readFile(r, 'notes.txt'))),
      [fileA, fileB]
    )
    assert.deepEqual(
      reads.map((r) => r.content),
      ['A initial', 'B initial']
    )
    await win.evaluate((root) => window.electronAPI.writeFile(root, 'notes.txt', 'A edited'), fileA)
    assert.equal(readFileSync(path.join(a.cwd, 'notes.txt'), 'utf8'), 'A edited')
    assert.equal(readFileSync(path.join(b.cwd, 'notes.txt'), 'utf8'), 'B initial')
    const tree = win.locator(`[data-fleet-files="${savedA.id}"]`)
    if (!(await tree.count())) await win.getByTitle(/^File tree/).click()
    await tree.getByRole('button', { name: 'notes.txt', exact: true }).click()
    const editor = win.locator('.cm-content[contenteditable="true"]:visible')
    await editor.waitFor()
    assert.deepEqual(rendererErrors, [], 'remote file focus keeps the renderer alive')
    assert.equal(
      await win.locator(`[data-fleet-files="${savedA.id}"]`).count(),
      1,
      'remote file focus keeps the file panel on its owner'
    )
    await editor.fill('A edited in desktop')
    await editor.press('Meta+s')
    await check(
      () =>
        until(() => readFileSync(path.join(a.cwd, 'notes.txt'), 'utf8') === 'A edited in desktop'),
      'remote file editor saves bytes on its owner'
    )
    assert.equal(readFileSync(path.join(b.cwd, 'notes.txt'), 'utf8'), 'B initial')
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    await win
      .locator(`[data-fleet-files="${savedA.id}"]`)
      .getByRole('button', { name: 'remote.md', exact: true })
      .click()
    await sleep(400)
    assert.deepEqual(
      documentImageRequests.filter((url) => url.startsWith('file:')),
      [],
      'remote document must not request its image from the Mac filesystem'
    )
    await win
      .locator('.cm-content:visible')
      .filter({ hasText: '# From server A' })
      .waitFor({ timeout: 5000 })
    assert.equal(
      await win.locator('.mdxeditor:visible img').count(),
      0,
      'remote document image references are not interpreted as Mac paths'
    )
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    // Normal Upload from a navigated /tmp alias must use the visible owner root.
    await win
      .locator(`[data-fleet-files="${savedA.id}"]`)
      .getByRole('button', { name: 'uploads', exact: true })
      .click()
    const macUpload = path.join(root, 'mac-upload.txt')
    writeFileSync(macUpload, 'Mac upload owning-server byte sentinel')
    await app.evaluate(({ dialog }, source) => {
      globalThis.__fleetOpenDialog = dialog.showOpenDialog
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
    }, macUpload)
    try {
      await win
        .locator(`[data-fleet-files="${savedA.id}"]`)
        .getByRole('button', { name: 'Upload', exact: true })
        .click()
      assert.ok(
        await until(() => existsSync(path.join(a.cwd, 'uploads', 'mac-upload.txt'))),
        `normal UI upload must complete: ${await win.locator(`[data-fleet-files="${savedA.id}"]`).innerText()}`
      )
      assert.equal(
        readFileSync(path.join(a.cwd, 'uploads', 'mac-upload.txt'), 'utf8'),
        'Mac upload owning-server byte sentinel'
      )
      assert.equal(existsSync(path.join(b.cwd, 'uploads', 'mac-upload.txt')), false)
    } finally {
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = globalThis.__fleetOpenDialog
        delete globalThis.__fleetOpenDialog
      })
    }
    t.check('normal UI Upload from a navigated directory transfers exact owning bytes', true)
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const localImage = path.join(root, 'mac-image.png')
    writeFileSync(localImage, Buffer.from(png, 'base64'))
    const image = await win.evaluate(
      ({ id, file }) => window.electronAPI.sessionsFiles.prepare(id, { path: file }),
      { id: ka, file: localImage }
    )
    assert.ok(image.path.startsWith(`clave-owner:file:${savedA.id}:`))
    const remotePath = decodeURIComponent(image.path.split(':').at(-1))
    assert.ok(remotePath.startsWith(path.join(a.dir, 'session-attachments')))
    assert.equal(readFileSync(remotePath).toString('base64'), png)
    assert.ok(
      (await win.evaluate((file) => window.electronAPI.sessionsFiles.preview(file), image)).image
    )
    await win.evaluate(
      ({ id, file }) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'image to A',
          attachments: [file]
        }),
      { id: ka, file: image }
    )
    t.check('file reads/edits and selected Mac image bytes stay owner-scoped', true)

    await a.fixture.evaluate(
      (id) =>
        globalThis.__claveE2E.echo.inject(id, {
          kind: 'event',
          event: {
            type: 'permission_request',
            id: 'native-question',
            description: 'Native private clarification',
            toolName: 'item/tool/requestUserInput',
            input: { questions: [{ question: 'Private answer', isSecret: true }] },
            questions: [{ question: 'Private answer', options: [] }],
            options: [
              { id: 'answer', label: 'Answer' },
              { id: 'deny', label: 'Deny' }
            ]
          }
        }),
      collision
    )
    const privateInput = win.locator('input[aria-label="Private answer"]')
    await privateInput.waitFor()
    assert.equal(await privateInput.getAttribute('type'), 'password')
    assert.equal(
      await win.locator('.chat-prompt-options[aria-label="Private answer"]').count(),
      0,
      'all native views defer to the shared masked request UI'
    )
    await privateInput.fill('test-only-private-answer')
    await win.getByRole('button', { name: 'Answer', exact: true }).click()
    await privateInput.waitFor({ state: 'detached' })
    assert.equal(
      await win
        .locator('body')
        .innerText()
        .then((s) => s.includes('test-only-private-answer')),
      false
    )
    t.check(
      'native clarification replays through the common request UI with masked answers and settles',
      true
    )

    // An actual recording JSON-RPC child exercises the provider boundary.
    // It performs no model inference and records no initialization credentials.
    const providerFile = path.join(a.dir, 'question-provider.cjs')
    const providerReplies = path.join(a.dir, 'question-provider-replies.jsonl')
    const providerLaunches = path.join(a.dir, 'question-provider-launches.jsonl')
    const providerThread = '22222222-2222-4222-8222-222222222222'
    const providerRollout = path.join(
      a.dir,
      'recording-codex-rollouts',
      `rollout-desktop-${providerThread}.jsonl`
    )
    writeFileSync(
      providerFile,
      `
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const frame = JSON.parse(line);
        if (frame.id === 'native-input' && frame.result) {
          fs.appendFileSync(${JSON.stringify(providerReplies)}, JSON.stringify(frame)+'\\n');
          return;
        }
        if (frame.id === undefined) return;
        if (frame.method === 'thread/start' || frame.method === 'thread/resume')
          fs.appendFileSync(${JSON.stringify(providerLaunches)}, JSON.stringify({method:frame.method,cwd:frame.params?.cwd,threadId:frame.params?.threadId})+'\\n');
        const result = ['thread/start','thread/resume','thread/read'].includes(frame.method)
          ? {thread:{id:${JSON.stringify(providerThread)},turns:[]}} : frame.method === 'model/list' ? {data:[],nextCursor:null} : frame.method === 'turn/start' ? {turn:{id:'recorded-turn',status:'completed'}} : {};
        process.stdout.write(JSON.stringify({id:frame.id,result})+'\\n');
        if (frame.method === 'turn/start') {
          const text = frame.params.input.filter(item => item.type === 'text').map(item => item.text).join('\\n');
          const reply = 'Recorded provider reply: '+text;
          fs.writeFileSync(${JSON.stringify(providerRollout)}, [
            {type:'session_meta',payload:{id:${JSON.stringify(providerThread)},cwd:${JSON.stringify(a.cwd)}}},
            {type:'turn_context',payload:{turn_id:'recorded-turn'}},
            {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},
            {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:reply}]}}
          ].map(row => JSON.stringify(row)).join('\\n')+'\\n', {mode:0o600});
          process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:${JSON.stringify(providerThread)},turnId:'recorded-turn',item:{type:'agentMessage',id:'recorded-reply',text:reply}}})+'\\n');
          process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:${JSON.stringify(providerThread)},turn:{id:'recorded-turn',status:'completed'}}})+'\\n');
        }
        if (frame.method === 'thread/start') process.stdout.write(JSON.stringify({
          id:'native-input',method:'item/tool/requestUserInput',params:{
            threadId:${JSON.stringify(providerThread)},turnId:'desktop-fixture-turn',itemId:'desktop-fixture-item',isBlocking:true,
            questions:[
              {id:'public-question-id',header:'Public value',question:'Value?',isSecret:false,options:null},
              {id:'private-question-id',header:'Private value',question:'Value?',isSecret:true,options:null}
            ]
          }
        })+'\\n');
      });
    `
    )
    await post(a, '/launch-profiles', {
      profile: {
        id: 'desktop-protocol',
        name: 'Desktop protocol fixture',
        family: 'codex',
        command: [process.execPath, providerFile],
        additionalArgs: []
      }
    })
    await win.getByLabel('Manage Clave servers', { exact: true }).click()
    await win
      .locator(`[data-server-id="${savedA.id}"]`)
      .getByRole('button', { name: 'New session', exact: true })
      .click()
    await win.getByLabel('Session provider', { exact: true }).click()
    await win.getByRole('menuitem', { name: 'codex', exact: true }).click()
    await win.getByLabel('Server launch profile', { exact: true }).click()
    await win
      .getByRole('menuitem', { name: 'Desktop protocol fixture (chat)', exact: true })
      .click()
    await win.getByLabel('Server folder', { exact: true }).fill(a.cwd)
    await win.getByRole('button', { name: 'Start session', exact: true }).click()
    const pendingNative = await until(async () => {
      const response = await fetch(`${a.url}/requests/pending`, {
        headers: { authorization: `Bearer ${a.token}` }
      })
      assert.equal(response.status, 200)
      return (await response.json()).pending.find((r) => r.providerRequestId === '"native-input"')
    })
    assert.ok(pendingNative, 'the real provider request reaches owning pending HTTP snapshot')
    assert.deepEqual(
      pendingNative.questions.map((q) => q.id),
      ['public-question-id', 'private-question-id']
    )
    assert.deepEqual(pendingNative.secretQuestions, ['private-question-id'])
    const providerKey = owned('session', savedA.id, pendingNative.sessionId)
    const publicQuestion = win.getByLabel('Public value', { exact: true })
    const privateQuestion = win.getByLabel('Private value', { exact: true })
    await publicQuestion.waitFor()
    assert.equal(await publicQuestion.getAttribute('type'), 'text')
    assert.equal(await privateQuestion.getAttribute('type'), 'password')
    await publicQuestion.fill('public fixture answer')
    await privateQuestion.fill('private fixture answer')
    assert.equal(await publicQuestion.inputValue(), 'public fixture answer')
    assert.equal(await privateQuestion.inputValue(), 'private fixture answer')
    assert.equal((await win.locator('body').innerText()).includes('private-question-id'), false)
    await win
      .getByRole('button', {
        name: pendingNative.options.find((option) => option.id === 'answer').label,
        exact: true
      })
      .click()
    await privateQuestion.waitFor({ state: 'detached' })
    assert.equal((await win.locator('body').innerText()).includes('private fixture answer'), false)
    const replies = () =>
      existsSync(providerReplies)
        ? readFileSync(providerReplies, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    await check(
      () => until(() => replies().length === 1),
      'one actual provider JSON-RPC response is written'
    )
    assert.deepEqual(replies(), [
      {
        id: 'native-input',
        result: {
          answers: {
            'public-question-id': { answers: ['public fixture answer'] },
            'private-question-id': { answers: ['private fixture answer'] }
          }
        }
      }
    ])
    const duplicate = await post(a, '/requests/resolve', {
      requestId: pendingNative.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: {
          'public-question-id': 'public fixture answer',
          'private-question-id': 'private fixture answer'
        }
      }
    })
    assert.equal(duplicate.accepted, false)
    assert.equal(replies().length, 1)
    assert.equal(
      JSON.parse(readFileSync(providerLaunches, 'utf8').trim().split('\n')[0]).cwd,
      a.cwd,
      'selected folder reaches the actual provider on its server'
    )
    t.check(
      'server profile UI and same-label public/private inputs map to exact provider IDs once',
      true
    )
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'recorded provider turn'
        }),
      providerKey
    )
    await check(
      () => until(() => existsSync(providerRollout)),
      'actual provider turn writes its rollout inside the isolated daemon root'
    )
    await check(
      () =>
        until(async () =>
          (await win.locator(`[data-session-id="${providerKey}"]`).innerText()).includes(
            'Recorded provider reply: recorded provider turn'
          )
        ),
      'actual protocol turn reply reaches the native desktop transcript'
    )

    await win.evaluate((id) => window.electronAPI.fleetDisconnect(id), savedA.id)
    await check(
      () =>
        until(() =>
          win.locator(`[data-sidebar-item-id="${ka}"] [data-fleet-state="disconnected"]`).count()
        ),
      'intentional disconnect retains offline rows'
    )
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'B works while A disconnected'
        }),
      kb
    )
    await assert.rejects(win.evaluate((id) => window.electronAPI.sessionsHistory(id), ka))
    await a.fixture.evaluate((id) => {
      globalThis.__claveE2E.echo.inject(id, {
        kind: 'event',
        event: { type: 'user_message', text: 'missed while this Mac was disconnected' }
      })
      globalThis.__claveE2E.echo.inject(id, {
        kind: 'event',
        event: { type: 'assistant_text', delta: 'owner reply while disconnected', final: true }
      })
    }, collision)
    await win.evaluate((id) => window.electronAPI.fleetConnect(id), savedA.id)
    await check(
      () =>
        until(() => win.evaluate((id) => globalThis.fleetStatus[id] === 'connected', savedA.id)),
      'intentional reconnect succeeds'
    )
    const reconnectHistory = await win.evaluate((id) => window.electronAPI.sessionsHistory(id), ka)
    t.check(
      'disconnect retains remote sessions, rejects stale owner calls and leaves the other server usable',
      true
    )

    await win.evaluate((id) => window.electronAPI.killSession(id), kb)
    await check(
      () => until(async () => (await win.locator(`[data-sidebar-item-id="${kb}"]`).count()) === 0),
      'close propagates from owning server'
    )
    assert.ok(
      (await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedA.id)).sessions.some(
        (s) => s.id === ka
      )
    )
    await win.evaluate((id) => window.electronAPI.killSession(id), terminal.id)
    assert.ok(terminalWire)
    assert.deepEqual(rendererErrors, [], 'desktop has no uncaught renderer errors')
    t.check('closing one colliding tab removes only its owning server tab', true)
    assert.ok(reconnectHistory.items.length > 0, 'owning live history survives reconnect')
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    await win
      .locator(
        `[data-session-id="${ka}"] [data-testid="chat-view"] .chat-turn[data-role="assistant"]`
      )
      .filter({ hasText: 'owner reply while disconnected' })
      .waitFor()
    assert.ok(
      JSON.stringify(histories[0]).includes('message only for server A'),
      'live history contains the turn sent through this desktop'
    )
    t.check('owning live history and missed native turns catch up after reconnect', true)

    // Reboot the owning daemon on its originally held port and data directory.
    // No client-side adoption may spawn the persisted provider before Resume.
    const oldToken = a.token
    const oldServerId = a.serverId
    const savedDir = a.dir
    const savedPort = Number(new URL(a.url).port)
    await a.stop()
    a = await daemon('a-restarted', { dir: savedDir, port: savedPort })
    servers[0] = a
    assert.ok(a.token === oldToken, 'owning daemon retains its credential across restart')
    assert.ok(a.serverId === oldServerId, 'owning daemon retains its identity across restart')
    const launches = () =>
      readFileSync(providerLaunches, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    await check(
      () =>
        until(() => win.evaluate((id) => globalThis.fleetStatus[id] === 'connected', savedA.id)),
      'desktop reconnects to restarted owning daemon'
    )
    await check(
      () =>
        until(async () => {
          const snapshot = await win.evaluate(
            (id) => window.electronAPI.fleetSnapshot(id),
            savedA.id
          )
          return snapshot.sessions.some(
            (session) => session.id === providerKey && session.state === 'ended'
          )
        }),
      'persisted native provider is visible as stopped after server restart'
    )
    assert.equal(launches().length, 1, 'desktop did not implicitly restart the stopped provider')
    await win.locator(`[data-sidebar-item-id="${providerKey}"]`).click()
    await win
      .locator(`[data-session-id="${providerKey}"]`)
      .getByRole('button', { name: 'Resume', exact: true })
      .click()
    await check(
      () => until(() => launches().some((entry) => entry.method === 'thread/resume')),
      'explicit Resume reaches original provider thread on owning server'
    )
    assert.equal(launches().filter((entry) => entry.method === 'thread/start').length, 1)
    assert.equal(launches().filter((entry) => entry.method === 'thread/resume').length, 1)
    assert.equal(
      launches().find((entry) => entry.method === 'thread/resume').threadId,
      providerThread
    )
    assert.deepEqual(rendererErrors, [], 'restart and Resume keep the renderer alive')
    await win.evaluate((id) => window.electronAPI.killSession(id), providerKey)
    t.check(
      'server restart retains stopped native tab without replay; explicit desktop Resume resumes original thread',
      true
    )
  } finally {
    if (app) await app.close()
    for (const server of servers.reverse()) await server.stop()
  }
}
