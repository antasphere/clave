// A Pi or an OpenCode CHAT on a stored provider connection (PRDCT-4427 with
// PRDCT-4496). The rule: the connection a tab names is the credential its
// process uses. A chat's process is not a shell a spec can make print, so
// `opencode` and `pi` on the PATH are shell scripts that write what their
// process was handed (the connection's variables, the configuration, the
// directory, the arguments) to a file of this spec's fixture root, then run
// lane D's stand-ins (tests/e2e/fixtures/acp-agent.mjs, pi-rpc-agent.mjs),
// which never call a provider.
//
// What it proves, each on the agent's road (`clave_open_session` with the
// connection named by its label, `chat: true`):
// - an OpenCode chat on DeepSeek runs `opencode acp` with the DeepSeek value
//   under DEEPSEEK_API_KEY and a configuration naming the variable, the
//   connection's provider alone and the model in OpenCode's own form; the
//   session opens on that model (the stand-in reads the configuration the way
//   OpenCode 2.3.0 does), so the adapter switches nothing and posts no notice
//   about a model it could not set; the chat answers a message;
// - a Pi chat on Kimi runs `pi --mode rpc` with the Kimi value under
//   KIMI_API_KEY, in the connection's own directory, `--provider kimi-coding`;
//   the person's Pi home has no `sessions` folder, so the session Pi writes
//   lands in the connection's directory alone, and a Resume of the chat
//   resumes it (`--session <id>`): the guard looked where Pi runs;
// - Pi refuses `--provider` without `--model` (Pi 1.5.2, and the stand-in
//   does the same): the agent's Pi chat on Kimi names no model, so it starts
//   on the first model listed for Kimi, the person's default being another
//   provider's (PRDCT-4496);
// - a Pi or OpenCode chat whose agent prints a line and exits before it
//   speaks shows that line and the status, once, in process and on the app's
//   own separate server (PRDCT-4427);
// - a spawn on a connection with no key, or one that is gone, is refused in
//   that one sentence, on the chat road as on the terminal road; a Resume of
//   a chat whose connection was removed fails on the same sentence;
// - the values are in no file of the data folder, no record, no clave_list,
//   no transcript a reader gets (clave_read_session), no process command line.
//
// Every value is made up and masked in failure details anyway. Pinned to the
// in-process server, as lane D's chat specs are: the stubs are found on the
// PATH the app was launched with. tmux is off for the run.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  REPO,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('provider-connections-chat')
const DIR_SEPARATE = userDataDir('provider-connections-chat-separate')
const ROOT = fixturePath('provider-connections-chat-root')
const PI_HOME = path.join(ROOT, 'pi-agent')
const SEEN = path.join(ROOT, 'seen.jsonl')
// While this file exists, both stand-ins print a line on stderr and exit 3
// before they speak their protocol (defect 2 of the trial, PRDCT-4427).
const REFUSE_MARK = path.join(ROOT, 'refuse-before-protocol')
const ACP_STATE = path.join(ROOT, 'acp-state')
const ACP_FRAMES = path.join(ACP_STATE, 'frames.jsonl')
const ACP_AGENT = path.join(REPO, 'tests/e2e/fixtures/acp-agent.mjs')
const PI_AGENT = path.join(REPO, 'tests/e2e/fixtures/pi-rpc-agent.mjs')
const WS = {
  id: 'chat-conn-ws',
  name: 'Chat connections',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
// Pi's own folder for a working directory's sessions, under a home.
const PI_CWD_FOLDER = `--${ROOT.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`

const KIMI = 'e2e-made-up-chat-kimi-0001'
const DEEPSEEK = 'e2e-made-up-chat-deepseek-0001'
const MADE_UP = { KIMI, DEEPSEEK }

const CATALOGUE = {
  fetchedAt: Date.now(),
  providers: [
    {
      id: 'kimi-code-plan-global',
      name: 'Kimi For Coding',
      env: ['KIMI_API_KEY'],
      models: [
        {
          id: 'k-retired',
          name: 'Retired',
          reasoning: false,
          toolCall: true,
          status: 'deprecated'
        },
        { id: 'k-first', name: 'Kimi First', reasoning: false, toolCall: true },
        { id: 'k-second', name: 'Kimi Second', reasoning: false, toolCall: true }
      ]
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      env: ['DEEPSEEK_API_KEY'],
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false, toolCall: true }]
    }
  ]
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function scrub(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return text
  for (const [name, secret] of Object.entries(MADE_UP))
    text = text.split(secret).join(`‹${name.toLowerCase()}›`)
  return text
}
const holdsValue = (text) => Object.values(MADE_UP).some((v) => text.includes(v))
const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/
const sentence = (message) => (message == null ? message : String(message).replace(IPC_PREFIX, ''))

function writeFixtures() {
  rmSync(DIR, { recursive: true, force: true })
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  // The person's Pi home: a settings file, and no `sessions` folder yet (a
  // person whose first Pi runs on a connection).
  mkdirSync(PI_HOME, { recursive: true })
  // The person's own Pi default is on another provider than Kimi's: a Pi
  // chat on Kimi that names no model starts on the first model the launcher
  // lists for Kimi (PRDCT-4496).
  writeFileSync(
    path.join(PI_HOME, 'settings.json'),
    JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-made-up' }) + '\n'
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  // The catalogue's cache, fresh: models.dev is never asked, and the list the
  // launcher shows for Kimi is this one.
  writeFileSync(path.join(DIR, 'models-catalog.json'), JSON.stringify(CATALOGUE))
  seedTrustedRoots(DIR, [ROOT])
  // The second pass, on the app's own separate server (defect 2 was met there).
  rmSync(DIR_SEPARATE, { recursive: true, force: true })
  seedWorkspaces(DIR_SEPARATE, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR_SEPARATE, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // What a process was handed, one line per start. Test values only.
  writeFileSync(
    `${ROOT}/bin/seen.mjs`,
    `import { appendFileSync } from 'node:fs'
const [file, kind, ...argv] = process.argv.slice(2)
const e = process.env
appendFileSync(file, JSON.stringify({
  kind, argv,
  KIMI: e.KIMI_API_KEY ?? '', DS: e.DEEPSEEK_API_KEY ?? '', CLAVE: e.CLAVE_CONNECTION_API_KEY ?? '',
  DIR: e.PI_CODING_AGENT_DIR ?? '', CFG: e.OPENCODE_CONFIG_CONTENT ?? ''
}) + '\\n')
`
  )
  writeFileSync(
    `${ROOT}/bin/opencode`,
    `#!/bin/sh
if [ "$1" = "acp" ]; then
  ${quote(process.execPath)} ${quote(`${ROOT}/bin/seen.mjs`)} ${quote(SEEN)} opencode "$@"
  if [ -f ${quote(REFUSE_MARK)} ]; then
    echo "opencode stand-in: refused before speaking" >&2
    exit 3
  fi
  ACP_STAND_IN_STATE=${quote(ACP_STATE)}
  export ACP_STAND_IN_STATE
  exec ${quote(process.execPath)} ${quote(ACP_AGENT)} acp
fi
if [ "$1" = "--version" ]; then echo "opencode 2.3.0"; exit 0; fi
echo "stub opencode terminal"
exec sleep 600
`,
    { mode: 0o755 }
  )
  // Pi keeps its sessions under the directory it runs in: the stand-in is
  // pointed at that directory's folder for the root, as Pi itself would be.
  writeFileSync(
    `${ROOT}/bin/pi`,
    `#!/bin/sh
case " $* " in
  *" --mode rpc "*)
    ${quote(process.execPath)} ${quote(`${ROOT}/bin/seen.mjs`)} ${quote(SEEN)} pi "$@"
    if [ -f ${quote(REFUSE_MARK)} ]; then
      echo "pi stand-in: refused before speaking" >&2
      exit 3
    fi
    PI_STAND_IN_STATE="\${PI_CODING_AGENT_DIR}/sessions/${PI_CWD_FOLDER}"
    PI_STAND_IN_ANY_PROVIDER=1
    export PI_STAND_IN_STATE PI_STAND_IN_ANY_PROVIDER
    exec ${quote(process.execPath)} ${quote(PI_AGENT)} "$@"
    ;;
esac
if [ "$1" = "--version" ]; then echo "1.5.2"; exit 0; fi
echo "stub pi terminal"
exec sleep 600
`,
    { mode: 0o755 }
  )
}

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const seen = (kind) => lines(SEEN).filter((s) => s.kind === kind)
const after = (argv, flag) => (argv ?? [])[(argv ?? []).indexOf(flag) + 1]

/** Every regular file under `dir`, links never followed. */
function regularFiles(dir) {
  const out = []
  const walk = (d) => {
    let names = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      const file = path.join(d, name)
      let st
      try {
        st = lstatSync(file)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(file)
      else if (st.isFile()) out.push({ file, size: st.size })
    }
  }
  walk(dir)
  return out
}

/** A Pi and an OpenCode chat whose agent prints a line on stderr and exits 3
 *  before it speaks its protocol: the pane shows that line and the status,
 *  once, and no connection value (PRDCT-4427). The stand-ins refuse while
 *  `REFUSE_MARK` exists. */
async function refusedAtStart(t, app, win, { account, where }) {
  const chat = (id) =>
    win.locator(`.chat-host[data-session-id="${id}"]`).locator('[data-testid="chat-view"]').first()
  const chatText = async (id) =>
    chat(id)
      .innerText()
      .catch(() => '')
  writeFileSync(REFUSE_MARK, '')
  try {
    for (const [name, mode, words] of [
      ['Pi', 'pi', 'pi stand-in: refused before speaking'],
      ['OpenCode', 'opencode', 'opencode stand-in: refused before speaking']
    ]) {
      const opened = await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode,
        chat: true,
        workspace: WS.id,
        ...(account ? { account } : {}),
        ...(mode === 'pi' && account ? { model: 'kimi-for-coding' } : {}),
        name: `${name} refused`
      }).catch((e) => ({ error: String(e?.message ?? e) }))
      const id = opened?.sessionId
      t.check(`(${where}) the ${name} chat whose agent refuses opened`, !!id, scrub(opened))
      if (!id) continue
      await callMcp(app, 'focus', { sessionId: id })
      await chat(id)
        .waitFor({ timeout: 20_000 })
        .catch(() => undefined)
      const said = await until(async () => ((await chatText(id)).includes(words) ? true : null), {
        tries: 60
      })
      const shown = await chatText(id)
      t.check(
        `(${where}) the ${name} chat shows the agent's last words, not only "Session ended"`,
        !!said,
        scrub(shown).slice(0, 600)
      )
      t.check(
        `(${where}) and its exit status`,
        /exit status 3/.test(shown),
        scrub(shown).slice(0, 600)
      )
      t.equal(`(${where}) once`, shown.split(words).length - 1, 1)
      t.check(`(${where}) and no connection value`, !holdsValue(shown), shown.length)
    }
  } finally {
    rmSync(REFUSE_MARK, { force: true })
  }
}

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: PI_HOME
  }
  let app = null
  const errors = []
  try {
    const launched = await launchApp(DIR, {
      server: 'in-process',
      args: ['--test-no-machine-usage'],
      env
    })
    app = launched.app
    const win = launched.win
    win.on('pageerror', (e) => errors.push(e.message))
    await win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const pane = (id) => win.locator(`.chat-host[data-session-id="${id}"]`)
    const chat = (id) => pane(id).locator('[data-testid="chat-view"]').first()
    const chatText = async (id) =>
      chat(id)
        .innerText()
        .catch(() => '')
    const say = (id, text) =>
      win.evaluate(
        async ({ id, text }) =>
          window.electronAPI.sessionsWrite(id, { type: 'user_message', text }),
        { id, text }
      )
    const recordsIn = (folder) => {
      const dir = path.join(folder, 'session-records')
      return existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => readFileSync(path.join(dir, f), 'utf8'))
        : []
    }
    const allRecords = () => [...new Set([userData, DIR])].flatMap(recordsIn)
    const recordOf = (id) =>
      allRecords()
        .map((r) => JSON.parse(r))
        .find((r) => r.id === id)

    // ── The connections, stored the way Settings stores them ──
    const C = await win.evaluate(
      async ({ kimi, deepseek }) => {
        const api = window.electronAPI
        const add = async (input, key) => {
          const created = await api.providerConnectionAdd(input)
          return (key ? await api.providerConnectionSetKey(created.id, key) : created).id
        }
        return {
          kimi: await add({ company: 'moonshot', label: 'Kimi work' }, kimi),
          ds: await add({ company: 'deepseek', label: 'DeepSeek' }, deepseek),
          empty: await add({ company: 'moonshot', label: 'Kimi empty' }, null)
        }
      },
      { kimi: KIMI, deepseek: DEEPSEEK }
    )
    t.check(
      'three connections are stored',
      Object.values(C).every((id) => typeof id === 'string' && id.length > 0),
      C
    )

    // ── 1. An OpenCode chat on DeepSeek, opened by an agent (which names no
    // model for OpenCode: the open drops it) ──
    const oc = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'opencode',
      chat: true,
      workspace: WS.id,
      account: 'DeepSeek',
      name: 'OpenCode on DeepSeek'
    })
    const ocId = oc?.sessionId
    t.check('the OpenCode chat opened', !!ocId, oc)
    await callMcp(app, 'focus', { sessionId: ocId })
    await chat(ocId).waitFor({ timeout: 20_000 })
    const kernel = (await win.evaluate(() => window.electronAPI.sessionsList())).find(
      (s) => s.id === ocId
    )
    t.check(
      'it runs on the opencode-chat adapter, events transport',
      kernel?.adapterId === 'opencode-chat' && kernel?.transport === 'events',
      kernel
    )
    const ocSeen = await until(() => seen('opencode')[0] ?? null, { tries: 60 })
    t.check('`opencode acp` started', JSON.stringify(ocSeen?.argv) === '["acp"]', scrub(ocSeen))
    t.check(
      'the DeepSeek value reached the ACP agent under DEEPSEEK_API_KEY',
      ocSeen?.DS === DEEPSEEK,
      scrub(ocSeen)
    )
    t.check('and no other connection’s', ocSeen?.KIMI === '' && ocSeen?.CLAVE === '', scrub(ocSeen))
    let cfg = null
    try {
      cfg = JSON.parse(ocSeen?.CFG ?? '')
    } catch {
      // Checked below.
    }
    t.equal(
      'its configuration names the variable and the connection’s provider alone',
      JSON.stringify(cfg),
      JSON.stringify({
        providers: { deepseek: { settings: { apiKey: '{env:DEEPSEEK_API_KEY}' } } },
        enabled_providers: ['deepseek']
      })
    )
    const opened = await until(
      () => (lines(ACP_FRAMES).some((f) => f.frame?.method === 'session/new') ? true : null),
      { tries: 60 }
    )
    t.check('the agent opened a session', !!opened)
    await say(ocId, 'hello on deepseek')
    await chat(ocId)
      .getByText('hello on deepseek')
      .last()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined)
    const answered = await until(
      async () =>
        /You said: hello on deepseek|hello on deepseek/.test(await chatText(ocId)) ? true : null,
      { tries: 40 }
    )
    t.check('the chat answers a message', !!answered, (await chatText(ocId)).slice(0, 500))
    t.check(
      'no model switch was asked of the agent',
      !lines(ACP_FRAMES).some((f) => f.frame?.method === 'session/set_config_option'),
      lines(ACP_FRAMES).map((f) => f.frame?.method)
    )
    const ocText = await chatText(ocId)
    t.check(
      'no notice about a model the chat could not set',
      !/does not offer the model|could not switch to/.test(ocText),
      ocText.slice(0, 600)
    )
    const ocRecord = await until(async () => recordOf(ocId))
    t.check(
      'the OpenCode chat’s record names its connection',
      ocRecord?.connectionId === C.ds && ocRecord?.connectionLabel === 'DeepSeek',
      ocRecord ? { connectionId: ocRecord.connectionId, label: ocRecord.connectionLabel } : null
    )

    // ── 1b. An OpenCode chat on DeepSeek with a picked model, the launcher's
    // call: the bare id `deepseek-chat`, as the launcher names it ──
    const history = (id) =>
      win.evaluate(async (id) => JSON.stringify(await window.electronAPI.sessionsHistory(id)), id)
    const ocSeenBefore = seen('opencode').length
    const ocModelId = await win.evaluate(
      async ({ root, ds, workspaceId }) => {
        const connection = { connectionId: ds, connectionLabel: 'DeepSeek' }
        const info = await window.electronAPI.spawnSession(root, {
          tmuxMode: false,
          launchProfileId: 'opencode-chat',
          claudeMode: false,
          opencodeMode: true,
          model: 'deepseek-chat',
          workspaceId,
          ...connection
        })
        // Placed in the sidebar the way the launcher places it.
        window.__claveSessionStoreForTests.getState().addSession({
          id: info.id,
          cwd: info.cwd,
          folderName: info.folderName,
          name: 'OpenCode on DeepSeek, a model',
          alive: info.alive,
          activityStatus: 'idle',
          promptWaiting: null,
          claudeMode: false,
          antigravityMode: false,
          codexMode: false,
          piMode: false,
          opencodeMode: true,
          claudeAgentsMode: false,
          dangerousMode: false,
          launchProfileId: info.launchProfileId,
          model: info.model,
          sessionType: 'local',
          workspaceId,
          ...connection
        })
        return info.id
      },
      { root: ROOT, ds: C.ds, workspaceId: WS.id }
    )
    t.check('the OpenCode chat with a model opened', !!ocModelId)
    await callMcp(app, 'focus', { sessionId: ocModelId })
    await chat(ocModelId).waitFor({ timeout: 20_000 })
    const ocModelSeen = await until(() => seen('opencode')[ocSeenBefore] ?? null, { tries: 60 })
    let modelCfg = null
    try {
      modelCfg = JSON.parse(ocModelSeen?.CFG ?? '')
    } catch {
      // Checked below.
    }
    t.equal(
      'its configuration names the model in OpenCode’s own form, deepseek/deepseek-chat',
      modelCfg?.model,
      'deepseek/deepseek-chat'
    )
    t.check(
      'and the value under DEEPSEEK_API_KEY',
      ocModelSeen?.DS === DEEPSEEK,
      scrub(ocModelSeen)
    )
    // The session the stand-in opened, and the model it runs on (its own
    // record of it, `sessions/<id>.json`).
    const standInModels = () =>
      existsSync(path.join(ACP_STATE, 'sessions'))
        ? readdirSync(path.join(ACP_STATE, 'sessions'))
            .filter((n) => n.endsWith('.json'))
            .map((n) => JSON.parse(readFileSync(path.join(ACP_STATE, 'sessions', n), 'utf8')).model)
        : []
    const agentModel = await until(
      () => (standInModels().includes('deepseek/deepseek-chat') ? true : null),
      { tries: 60 }
    )
    t.check('the agent’s session runs on deepseek/deepseek-chat', !!agentModel, standInModels())
    const chipText = async () =>
      chat(ocModelId).locator('.chat-model-trigger[aria-label="Model"]').first().innerText()
    const chipOk = await until(
      async () => /deepseek\/deepseek-chat/.test(await chipText().catch(() => '')),
      { tries: 40 }
    )
    t.check(
      'the chat’s model chip reads deepseek/deepseek-chat',
      !!chipOk,
      await chipText().catch((e) => e.message)
    )
    await win.evaluate(
      async (id) =>
        window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'hello with a model' }),
      ocModelId
    )
    const modelAnswered = await until(
      async () => (/You said: hello with a model/.test(await chatText(ocModelId)) ? true : null),
      { tries: 60 }
    )
    t.check('it answers a message', !!modelAnswered, scrub(await chatText(ocModelId)).slice(0, 400))
    t.check(
      'no model switch was asked of the agent, on either chat',
      !lines(ACP_FRAMES).some((f) => f.frame?.method === 'session/set_config_option'),
      lines(ACP_FRAMES).map((f) => f.frame?.method)
    )
    const modelShown = await chatText(ocModelId)
    t.check(
      'its pane shows no notice about a model it could not set',
      !/does not offer the model|could not switch to/.test(modelShown),
      scrub(modelShown).slice(0, 600)
    )
    // A Resume relaunches on the model the agent reported (`provider/model`):
    // OpenCode is handed it as it is, never prefixed twice.
    const ocResumeBefore = seen('opencode').length
    const ocRestarted = await win.evaluate(
      async (id) =>
        window.electronAPI.restartSession(id, {}, undefined).then(
          (r) => r,
          (e) => ({ error: String(e?.message ?? e) })
        ),
      ocModelId
    )
    t.check(
      'the OpenCode chat with a model restarts',
      ocRestarted && !('error' in ocRestarted),
      scrub(ocRestarted)
    )
    const ocResumedSeen = await until(() => seen('opencode')[ocResumeBefore] ?? null, { tries: 60 })
    let resumedCfg = null
    try {
      resumedCfg = JSON.parse(ocResumedSeen?.CFG ?? '')
    } catch {
      // Checked below.
    }
    t.equal(
      'the restarted chat is handed deepseek/deepseek-chat again, not deepseek/deepseek/deepseek-chat',
      resumedCfg?.model,
      'deepseek/deepseek-chat'
    )
    t.check('and the value again', ocResumedSeen?.DS === DEEPSEEK, scrub(ocResumedSeen))

    // ── 2. A Pi chat on Kimi ──
    const pi = await callMcp(app, 'openSession', {
      cwd: ROOT,
      mode: 'pi',
      chat: true,
      workspace: WS.id,
      account: 'Kimi work',
      name: 'Pi on Kimi'
    })
    const piId = pi?.sessionId
    t.check('the Pi chat opened', !!piId, pi)
    await callMcp(app, 'focus', { sessionId: piId })
    await chat(piId).waitFor({ timeout: 20_000 })
    const piSeen = await until(() => seen('pi')[0] ?? null, { tries: 60 })
    const kimiDir = path.join(DIR, 'pi-connections', C.kimi)
    t.check('`pi --mode rpc` started', after(piSeen?.argv, '--mode') === 'rpc', scrub(piSeen))
    t.check('the Kimi value reached Pi under KIMI_API_KEY', piSeen?.KIMI === KIMI, scrub(piSeen))
    t.check(
      "Pi runs in the connection's own directory, not the person's",
      piSeen?.DIR?.endsWith(path.join('pi-connections', C.kimi)) && piSeen?.DIR !== PI_HOME,
      { printed: piSeen?.DIR, expected: kimiDir }
    )
    t.check(
      'Pi is told --provider kimi-coding',
      after(piSeen?.argv, '--provider') === 'kimi-coding',
      scrub(piSeen?.argv)
    )
    // Pi refuses --provider without --model before it speaks (Pi 1.5.2; the
    // stand-in does the same): the agent named no model, so the chat starts
    // on the first model the launcher lists for Kimi, the person's own Pi
    // default being another provider's (PRDCT-4496).
    t.equal(
      "and --model k-first, the first model listed for Kimi (the person's default is another provider's)",
      after(piSeen?.argv, '--model'),
      'k-first'
    )
    await say(piId, 'hello on kimi')
    const piAnswered = await until(
      async () => (/You said: hello on kimi/.test(await chatText(piId)) ? true : null),
      { tries: 60 }
    )
    t.check('the Pi chat answers a message', !!piAnswered, (await chatText(piId)).slice(0, 500))
    const piRecord = await until(async () => recordOf(piId)?.piSessionId && recordOf(piId))
    const piSession = piRecord?.piSessionId
    t.check(
      'the Pi chat’s record names its connection and its Pi session',
      piRecord?.connectionId === C.kimi &&
        piRecord?.connectionLabel === 'Kimi work' &&
        typeof piSession === 'string',
      piRecord ? { connectionId: piRecord.connectionId, piSessionId: piSession } : null
    )
    t.equal('and the model it started on', piRecord?.model, 'k-first')
    const connSessions = path.join(piSeen?.DIR ?? kimiDir, 'sessions', PI_CWD_FOLDER)
    const written = await until(
      () =>
        existsSync(connSessions) &&
        readdirSync(connSessions).some((n) => n.endsWith(`_${piSession}.jsonl`)),
      { tries: 40 }
    )
    t.check("Pi's session file is in the connection's directory", !!written, connSessions)
    t.check(
      "and the person's home has none (no sessions folder to link)",
      !existsSync(path.join(PI_HOME, 'sessions')),
      readdirSync(PI_HOME)
    )

    // ── 3. A Resume of the Pi chat resumes that session ──
    const before = seen('pi').length
    const restarted = await win.evaluate(
      async (id) =>
        window.electronAPI.restartSession(id, {}, undefined).then(
          (r) => r,
          (e) => ({ error: String(e?.message ?? e) })
        ),
      piId
    )
    t.check('the Pi chat restarts', restarted && !('error' in restarted), scrub(restarted))
    const resumedSeen = await until(() => seen('pi')[before] ?? null, { tries: 60 })
    t.check(
      'the restarted Pi resumes its session (--session <id>), found where it runs',
      after(resumedSeen?.argv, '--session') === piSession &&
        !(resumedSeen?.argv ?? []).includes('--session-id'),
      scrub(resumedSeen?.argv)
    )
    t.check(
      'and got the Kimi value again, in the connection’s directory',
      resumedSeen?.KIMI === KIMI && resumedSeen?.DIR === piSeen?.DIR,
      scrub(resumedSeen)
    )

    // ── 4. Refusals at start: one sentence, before any process ──
    const refuse = (options) =>
      win.evaluate(
        async ({ root, options }) =>
          window.electronAPI.spawnSession(root, { tmuxMode: false, ...options }).then(
            () => null,
            (e) => String(e?.message ?? e)
          ),
        { root: ROOT, options }
      )
    const startsBefore = lines(SEEN).length
    const noKeyPi = await refuse({
      launchProfileId: 'pi-chat',
      claudeMode: false,
      piMode: true,
      connectionId: C.empty,
      connectionLabel: 'Kimi empty'
    })
    t.equal(
      'a Pi chat on a connection with no key is refused in one sentence',
      sentence(noKeyPi),
      'The connection has no key yet.'
    )
    const noKeyOc = await refuse({
      launchProfileId: 'opencode-chat',
      claudeMode: false,
      opencodeMode: true,
      connectionId: C.empty,
      connectionLabel: 'Kimi empty'
    })
    t.equal(
      'an OpenCode chat on it, the same sentence',
      sentence(noKeyOc),
      'The connection has no key yet.'
    )
    const goneOc = await refuse({
      launchProfileId: 'opencode-chat',
      claudeMode: false,
      opencodeMode: true,
      connectionId: 'c-gone',
      connectionLabel: 'Gone'
    })
    t.equal(
      'an OpenCode chat on a connection that is gone is refused in one sentence',
      sentence(goneOc),
      'The selected connection is no longer available.'
    )
    const goneTerminal = await refuse({
      piMode: true,
      claudeMode: false,
      connectionId: 'c-gone',
      connectionLabel: 'Gone'
    })
    t.equal(
      'the terminal road says the same sentence',
      sentence(goneTerminal),
      'The selected connection is no longer available.'
    )
    t.equal('no process was started by a refused spawn', lines(SEEN).length, startsBefore)

    // ── 4b. An agent that ends before it speaks: its last words and its
    // status in the pane, never only "Session ended" (PRDCT-4427) ──
    await refusedAtStart(t, app, win, { account: 'Kimi work', where: 'in-process' })

    // ── 5. The values are nowhere but the processes ──
    const leaks = []
    for (const { file, size } of regularFiles(DIR)) {
      if (size > 64 * 1024 * 1024) continue
      let text
      try {
        text = readFileSync(file, 'latin1')
      } catch {
        continue
      }
      if (holdsValue(text)) leaks.push(path.relative(DIR, file))
    }
    t.check('no file under the data folder holds a connection value', leaks.length === 0, leaks)
    const records = allRecords()
    t.check(
      'no record holds a connection value',
      records.length > 0 && !records.some(holdsValue),
      records.length
    )
    t.check(
      'clave_list holds no connection value',
      !holdsValue(JSON.stringify(await callMcp(app, 'list', {})))
    )
    for (const [name, id] of [
      ['OpenCode', ocId],
      ['OpenCode (model)', ocModelId],
      ['Pi', piId]
    ]) {
      const read = JSON.stringify(
        await callMcp(app, 'readSession', { sessionId: id, lines: 200, callerSessionId: id })
      )
      t.check(
        `the ${name} chat's clave_read_session answer holds no value`,
        !holdsValue(read),
        read.length
      )
      const events = await history(id)
      t.check(`the ${name} chat's event history holds no value`, !holdsValue(events), events.length)
      // The live events, as the pane renders them.
      await callMcp(app, 'focus', { sessionId: id })
      await chat(id)
        .waitFor({ timeout: 20_000 })
        .catch(() => undefined)
      const shown = await chatText(id)
      t.check(`the ${name} chat's pane holds no value`, !holdsValue(shown), shown.length)
      t.check(
        `and shows the conversation (the read above read something)`,
        /hello (on|with)/.test(shown),
        scrub(shown).slice(0, 300)
      )
    }
    const table = execFileSync('ps', ['-axo', 'command'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    t.check('the process table holds no connection value', !holdsValue(table))
    t.check(
      'the chats’ agents are in the process table (the read above is not empty)',
      table.includes(ACP_AGENT) && table.includes(PI_AGENT),
      table.length
    )

    // ── 6. A Resume of a chat whose connection was removed: the same sentence ──
    const removed = await win.evaluate(
      (id) => window.electronAPI.providerConnectionRemove(id),
      C.ds
    )
    t.check('the DeepSeek connection is removed', removed === true, removed)
    const resumeGone = await win.evaluate(
      async (id) =>
        window.electronAPI.restartSession(id, {}, undefined).then(
          (r) => ('error' in r ? r.error : null),
          (e) => String(e?.message ?? e)
        ),
      ocId
    )
    t.equal(
      'a Resume of the OpenCode chat on it fails on that one sentence',
      sentence(resumeGone),
      'The selected connection is no longer available.'
    )
    t.check('no renderer error during the run', errors.length === 0, errors)
  } finally {
    if (app) await app.close()
  }

  // ── 7. The same refusals on the app's own separate server, where the trial
  // met them: the queue there is let go before the pane subscribes, and the
  // pane reads the chat's past (PRDCT-4427). No connection: the stand-ins
  // refuse on the marker alone. ──
  let separate = null
  try {
    separate = await launchApp(DIR_SEPARATE, {
      server: 'separate',
      args: ['--test-no-machine-usage'],
      env
    })
    await separate.win.evaluate(() => window.electronAPI.preferencesSet('tmuxMode', false))
    await until(async () => {
      try {
        return await callMcp(separate.app, 'list', {})
      } catch {
        return false
      }
    })
    await refusedAtStart(t, separate.app, separate.win, { where: 'separate server' })
  } finally {
    if (separate) await separate.app.close()
  }
}
