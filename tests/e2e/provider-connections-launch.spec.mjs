// A stored provider connection reaches a Pi or an OpenCode tab's PROCESS
// (PRDCT-4496). A dropped spawn field renders a perfect launcher and runs the
// harness on its own login, so every check here is what the tab's own shell
// prints: a launch profile of each family whose "pi" or "opencode" is a
// `sh -c` printing the variables the connection is meant to set, the
// directory Pi reads, and the arguments the harness was handed.
//
// What it proves: a Kimi connection reaches Pi through Pi's own variable and a
// directory of the connection's own (no auth.json, the person's models.json
// kept, the key a variable name); a provider Pi does not ship (Alibaba) and a
// local one (Ollama) are declared by Clave under Clave's own variable, the
// models from the catalogue; OpenCode is handed its configuration in the
// environment and `--standalone`; a tab on no connection runs as it always
// did; a connection that is gone refuses the start; the value is nowhere but
// the process (no file under the data folder, no record, no listing, no
// process table); a Resume of the Kimi tab gets the value again.
//
// Every value is made up (`e2e-made-up-…-0001`) and masked in every failure
// detail anyway. The person's Pi directory is a fixture of this spec's own
// (`PI_CODING_AGENT_DIR`), so ~/.pi is never read. models.dev is never asked:
// the catalogue's cache is seeded fresh before the launch, and main's `fetch`
// refuses that host.
//
// The road: the connections are stored the way Settings stores them, through
// lane B's own calls (`providerConnectionAdd`, then `providerConnectionSetKey`
// with a made-up key, Ollama with none), on the in-process server; their ids
// come back from the store. The tabs' shells run with a `ZDOTDIR` of this
// spec's own whose `.zshenv` exports the person's `PI_CODING_AGENT_DIR`, so a
// profile that sets it cannot outrank the connection's directory. A second
// pass on the app's own separate server proves the two launches that need no
// connection at all.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath,
  separateServerDataDir
} from './harness.mjs'

const DIR = userDataDir('provider-connections-launch')
const DIR2 = userDataDir('provider-connections-launch-separate')
const ROOT = fixturePath('provider-connections-launch-root')
const PI_HOME = fixturePath('provider-connections-launch-pi-home')
/** A `ZDOTDIR` of this spec's own: its `.zshenv` exports the person's Pi
 *  directory, as a profile of theirs would. */
const ZDOT = fixturePath('provider-connections-launch-zdotdir')
const WS = {
  id: 'connections-ws',
  name: 'Connections',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

const KIMI = 'e2e-made-up-kimi-0001'
const DEEPSEEK = 'e2e-made-up-deepseek-0001'
const ALIBABA = 'e2e-made-up-alibaba-0001'
const PI_OWN = 'e2e-made-up-pi-own-0001'
const OWN_PROVIDER = 'e2e-made-up-own-provider-0001'
/** The four values a connection carries: none may land anywhere but a process. */
const CONNECTION_VALUES = { KIMI, DEEPSEEK, ALIBABA, OLLAMA_NONE: null }
const MADE_UP = { KIMI, DEEPSEEK, ALIBABA, PI_OWN, OWN_PROVIDER }

const PI_FILES = {
  'auth.json': JSON.stringify({ 'kimi-coding': { type: 'api_key', key: PI_OWN } }, null, 2) + '\n',
  // The person's own Pi default is a Kimi model, the second Kimi lists: a Pi
  // tab on Kimi that names no model starts on it; one on another provider
  // starts on that provider's first listed model (PRDCT-4496).
  'settings.json':
    JSON.stringify({ defaultProvider: 'kimi-coding', defaultModel: 'k-second' }, null, 2) + '\n',
  'models.json':
    JSON.stringify(
      {
        providers: {
          'my-own': {
            baseUrl: 'http://127.0.0.1:9/v1',
            api: 'openai-completions',
            apiKey: OWN_PROVIDER,
            models: [{ id: 'own-one' }]
          }
        }
      },
      null,
      2
    ) + '\n'
}

const CATALOGUE = {
  fetchedAt: Date.now(),
  providers: [
    {
      id: 'alibaba-coding-plan',
      name: 'Alibaba Coding Plan',
      env: ['ALIBABA_CODING_PLAN_API_KEY'],
      // The deprecated one first: the first model LISTED is the next one.
      models: [
        { id: 'old-one', name: 'Old', reasoning: false, toolCall: false, status: 'deprecated' },
        { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', reasoning: false, toolCall: true }
      ]
    },
    {
      id: 'kimi-code-plan-global',
      name: 'Kimi For Coding',
      env: ['KIMI_API_KEY'],
      models: [
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

const PI_PRINT = [
  'sh',
  '-c',
  'printf "ZENV=%s\\nKIMI=%s\\nCLAVE=%s\\nDIR=%s\\nAUTH=%s\\nARGS=%s\\n" "$CLAVE_E2E_ZSHENV" "$KIMI_API_KEY" "$CLAVE_CONNECTION_API_KEY" "$PI_CODING_AGENT_DIR" "$(test -e "$PI_CODING_AGENT_DIR/auth.json" && echo present || echo absent)" "$0 $*"; sleep 60'
]
const OPENCODE_PRINT = [
  'sh',
  '-c',
  // MODEL and ENABLED are short excerpts of CFG: a line a pane can wrap is
  // read back whole through clave_read_session.
  'printf "DS=%s\\nCFG=%s\\nMODEL=%s\\nENABLED=%s\\nARGS=%s\\n" "$DEEPSEEK_API_KEY" "$OPENCODE_CONFIG_CONTENT" "$(printf %s "$OPENCODE_CONFIG_CONTENT" | grep -o \'"model":"[^"]*"\')" "$(printf %s "$OPENCODE_CONFIG_CONTENT" | grep -o \'"enabled_providers":\\[[^]]*\\]\')" "$0 $*"; sleep 60'
]

/** Never a value in a failure detail, made up or not. */
function scrub(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return text
  for (const [name, secret] of Object.entries(MADE_UP))
    text = text.split(secret).join(`‹${name.toLowerCase()}›`)
  return text
}

function holdsValue(text) {
  return Object.values(CONNECTION_VALUES).some((v) => v && text.includes(v))
}

/** The lines a tab printed, by name; null until its ARGS line is there. */
function parsePrinted(raw) {
  const out = {}
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const m = /^(ZENV|KIMI|CLAVE|DIR|AUTH|ARGS|DS|CFG|MODEL|ENABLED)=(.*)$/.exec(line)
    if (m && !(m[1] in out)) out[m[1]] = m[2]
  }
  return 'ARGS' in out ? out : null
}

function argTokens(printed) {
  return (printed?.ARGS ?? '').split(' ').filter(Boolean)
}

/** `flag value` adjacent in the tab's arguments. */
function hasPair(printed, flag, value) {
  const tokens = argTokens(printed)
  return tokens.some((t, i) => t === flag && tokens[i + 1] === value)
}

function writeFixtures(dataDir) {
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })
  seedWorkspaces(dataDir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dataDir, [ROOT])
  // The storage port's path: `<data dir>/models-catalog.json` (fileStorage).
  // The separate server keeps its own under `<data dir>/server`.
  for (const d of [dataDir, separateServerDataDir(dataDir)]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'models-catalog.json'), JSON.stringify(CATALOGUE))
  }
}

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

async function setProfiles(win) {
  await win.evaluate(
    async ({ workspaceId, pi, opencode }) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-pi-print',
        name: 'pi print',
        family: 'pi',
        command: pi,
        additionalArgs: []
      })
      await window.electronAPI.launchProfileUpsert({
        id: 'e2e-opencode-print',
        name: 'opencode print',
        family: 'opencode',
        command: opencode,
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetWorkspace(workspaceId, 'pi', 'e2e-pi-print')
      await window.electronAPI.launchProfileSetWorkspace(
        workspaceId,
        'opencode',
        'e2e-opencode-print'
      )
      await window.electronAPI.launchSettingsSet({ interactionMode: 'terminal' })
    },
    { workspaceId: WS.id, pi: PI_PRINT, opencode: OPENCODE_PRINT }
  )
}

/** A raw spawn, its output collected in the window before the PTY starts (it
 *  starts on its first size), so nothing it prints is missed. */
async function spawn(win, options) {
  return win.evaluate(
    async ({ root, options }) => {
      const out = (window.__connectionsOut ??= {})
      const info = await window.electronAPI.spawnSession(root, {
        tmuxMode: false,
        dangerousMode: false,
        ...options
      })
      out[info.id] = ''
      window.electronAPI.onSessionData(info.id, (d) => {
        out[info.id] += d
      })
      await window.electronAPI.resizeSession(info.id, 400, 60)
      return info.id
    },
    { root: ROOT, options }
  )
}

async function printedBy(win, id) {
  const got = await until(
    async () => parsePrinted(await win.evaluate((id) => window.__connectionsOut?.[id] ?? '', id)),
    { tries: 60, gapMs: 500 }
  )
  return got
}

async function rawOf(win, id) {
  return scrub(await win.evaluate((id) => window.__connectionsOut?.[id] ?? '', id)).slice(-1500)
}

/** Every print tab ended before the close, so none holds the quit up. */
async function stopTabs(win) {
  await win
    .evaluate(() =>
      Promise.all(
        Object.keys(window.__connectionsOut ?? {}).map((id) =>
          window.electronAPI.killSession(id).catch(() => undefined)
        )
      )
    )
    .catch(() => undefined)
}

/** A tab an agent opens through clave_open_session (the window's dispatcher),
 *  focused so it starts, and what its shell printed, read back through
 *  clave_read_session as claude-accounts.spec does. */
async function mcpOpenPrinted(app, payload) {
  const opened = await callMcp(app, 'openSession', { cwd: ROOT, ...payload })
  await callMcp(app, 'focus', { sessionId: opened.sessionId })
  let raw = ''
  const printed = await until(
    async () => {
      const read = await callMcp(app, 'readSession', {
        sessionId: opened.sessionId,
        lines: 40,
        callerSessionId: opened.sessionId
      })
      raw = read?.text ?? ''
      const out = {}
      for (const line of raw.replace(/\r/g, '').split('\n')) {
        const m = /^(KIMI|CLAVE|DIR|AUTH|ARGS|DS|CFG|MODEL|ENABLED)=(.*)$/.exec(line.trim())
        if (m && !(m[1] in out)) out[m[1]] = m[2]
      }
      return 'ARGS' in out ? out : null
    },
    { tries: 60, gapMs: 500 }
  )
  return { sessionId: opened.sessionId, printed, raw: raw.slice(-1500) }
}

async function spawnRefusal(win, options) {
  return win.evaluate(
    async ({ root, options }) =>
      window.electronAPI.spawnSession(root, { tmuxMode: false, ...options }).then(
        () => null,
        (e) => String(e?.message ?? e)
      ),
    { root: ROOT, options }
  )
}

export async function run(t) {
  // The person's Pi directory, as the spec writes it: compared byte for byte
  // after every launch.
  rmSync(PI_HOME, { recursive: true, force: true })
  mkdirSync(path.join(PI_HOME, 'sessions'), { recursive: true })
  writeFileSync(path.join(PI_HOME, 'sessions', 'one.jsonl'), '{}\n')
  for (const [name, text] of Object.entries(PI_FILES)) writeFileSync(path.join(PI_HOME, name), text)
  mkdirSync(ROOT, { recursive: true })
  writeFixtures(DIR)
  rmSync(DIR2, { recursive: true, force: true })

  // The tabs' zsh reads this `.zshenv`: the person's Pi directory exported,
  // and the spec's own PATH so the shell finds what it always did.
  rmSync(ZDOT, { recursive: true, force: true })
  mkdirSync(ZDOT, { recursive: true })
  writeFileSync(
    path.join(ZDOT, '.zshenv'),
    `export PATH=${JSON.stringify(process.env.PATH ?? '/usr/bin:/bin')}\nexport PI_CODING_AGENT_DIR=${JSON.stringify(PI_HOME)}\nexport CLAVE_E2E_ZSHENV=read\n`
  )
  const env = { PI_CODING_AGENT_DIR: PI_HOME, ZDOTDIR: ZDOT }
  const { app, win } = await launchApp(DIR, { server: 'in-process', env })
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    await app.evaluate(() => {
      const state = (globalThis.__connectionsFixture = { modelsDev: 0 })
      // models.dev is never reached: the cache seeded on disk is fresh, and
      // a request that still goes there is refused and counted.
      const original = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('models.dev')) {
          state.modelsDev++
          throw new Error('models.dev is not reached from a test')
        }
        return original(url, init)
      }
    })
    // ── The connections, stored through lane B's road ─────────────────────
    const stored = await win.evaluate(
      async ({ kimi, deepseek, alibaba }) => {
        const api = window.electronAPI
        const add = async (input, key) => {
          const created = await api.providerConnectionAdd(input)
          const view = key ? await api.providerConnectionSetKey(created.id, key) : created
          return { id: view.id, hasKey: view.hasKey, needsKey: view.needsKey }
        }
        return {
          kimi: await add({ company: 'moonshot', label: 'Kimi work' }, kimi),
          ds: await add({ company: 'deepseek', label: 'DeepSeek' }, deepseek),
          ali: await add({ company: 'alibaba', label: 'Alibaba plan' }, alibaba),
          ollama: await add({ company: 'ollama', label: 'Local Ollama' }, null)
        }
      },
      { kimi: KIMI, deepseek: DEEPSEEK, alibaba: ALIBABA }
    )
    const C = {
      kimi: stored.kimi.id,
      ds: stored.ds.id,
      ali: stored.ali.id,
      ollama: stored.ollama.id
    }
    t.check(
      'the four connections are stored, the three keys sealed, Ollama taking none',
      Object.values(C).every((id) => typeof id === 'string' && id.length > 0) &&
        stored.kimi.hasKey &&
        stored.ds.hasKey &&
        stored.ali.hasKey &&
        !stored.ollama.needsKey,
      scrub(stored)
    )
    const listedConnections = JSON.stringify(
      await win.evaluate(() => window.electronAPI.providerConnectionsList())
    )
    t.check(
      'the store lists them, and its answer holds no key',
      Object.values(C).every((id) => listedConnections.includes(id)) &&
        !holdsValue(listedConnections),
      holdsValue(listedConnections) ? '[a key in the list]' : listedConnections.length
    )
    await setProfiles(win)

    // ── Pi on a Kimi connection: Pi's own provider, its own variable ─────
    const kimiId = await spawn(win, {
      piMode: true,
      launchProfileId: 'e2e-pi-print',
      connectionId: C.kimi,
      connectionLabel: 'Kimi work'
    })
    const kimi = await printedBy(win, kimiId)
    const kimiDir = path.join(DIR, 'pi-connections', C.kimi)
    t.check('the Pi tab on Kimi printed its lines', !!kimi, await rawOf(win, kimiId))
    t.check(
      'the Kimi value reached the process under KIMI_API_KEY',
      kimi?.KIMI === KIMI,
      scrub(kimi)
    )
    t.check(
      "Clave's own variable is not set for a provider Pi ships",
      kimi?.CLAVE === '',
      scrub(kimi)
    )
    t.check(
      "the Kimi tab's environment carries what the spec's .zshenv exports",
      kimi?.ZENV === 'read',
      { zenv: kimi?.ZENV }
    )
    t.check(
      "Pi runs in the connection's own directory, though the shell's .zshenv exports the person's",
      kimi?.DIR === kimiDir || kimi?.DIR === path.join(realpathSync(DIR), 'pi-connections', C.kimi),
      { printed: kimi?.DIR, expected: kimiDir }
    )
    t.check(
      "the connection's directory has no auth.json for Pi to find",
      kimi?.AUTH === 'absent',
      scrub(kimi)
    )
    t.check(
      'Pi is told the provider: --provider kimi-coding',
      hasPair(kimi, '--provider', 'kimi-coding'),
      scrub(kimi?.ARGS)
    )
    // Pi refuses --provider without --model (Pi 1.5.2): no model was named,
    // so the person's own Pi default, a Kimi model, is the one (PRDCT-4496).
    t.check(
      "and --model k-second, the person's own Pi default, Kimi's",
      hasPair(kimi, '--model', 'k-second'),
      scrub(kimi?.ARGS)
    )
    const linkTo = (name) => {
      try {
        const st = lstatSync(path.join(kimiDir, name))
        return st.isSymbolicLink() ? readlinkSync(path.join(kimiDir, name)) : 'not a link'
      } catch {
        return 'missing'
      }
    }
    t.equal(
      'sessions is a link to the person’s own',
      linkTo('sessions'),
      path.join(PI_HOME, 'sessions')
    )
    // A copy since f760bc15: what Pi saves in a connection tab stays there.
    let settingsCopy = null
    try {
      settingsCopy = readFileSync(path.join(kimiDir, 'settings.json'), 'utf8')
    } catch {
      // Missing: fails below.
    }
    t.check(
      'settings.json is a copy of the person’s own, not a link',
      linkTo('settings.json') === 'not a link' && settingsCopy === PI_FILES['settings.json'],
      { link: linkTo('settings.json'), copied: settingsCopy !== null }
    )
    t.check(
      'no auth.json in the connection’s directory',
      !existsSync(path.join(kimiDir, 'auth.json'))
    )
    let kimiModels = null
    try {
      t.check(
        'models.json is a real file',
        !lstatSync(path.join(kimiDir, 'models.json')).isSymbolicLink()
      )
      kimiModels = JSON.parse(readFileSync(path.join(kimiDir, 'models.json'), 'utf8'))
    } catch (e) {
      t.check('models.json is readable', false, e.message)
    }
    t.equal(
      "models.json names Kimi's key by its variable, never its value",
      kimiModels?.providers?.['kimi-coding']?.apiKey,
      '$KIMI_API_KEY'
    )
    t.check(
      "the person's own provider is kept intact",
      JSON.stringify(kimiModels?.providers?.['my-own']) ===
        JSON.stringify(JSON.parse(PI_FILES['models.json']).providers['my-own']),
      scrub(kimiModels?.providers?.['my-own'])
    )

    // ── Resume: the restarted Kimi tab gets the value again ──────────────
    await win.evaluate((id) => {
      window.__connectionsOut[id] = ''
    }, kimiId)
    const restarted = await win.evaluate(async (id) => {
      const r = await window.electronAPI.restartSession(id, {}, undefined)
      if (r && !('error' in r)) await window.electronAPI.resizeSession(id, 400, 60)
      return r
    }, kimiId)
    t.check('the Kimi tab restarts', restarted && !('error' in restarted), scrub(restarted))
    const resumed = await printedBy(win, kimiId)
    t.check(
      'the restarted Kimi tab got the value again',
      resumed?.KIMI === KIMI,
      await rawOf(win, kimiId)
    )
    t.check(
      'and runs in the connection’s directory again',
      resumed?.DIR?.endsWith(path.join('pi-connections', C.kimi)) && resumed?.AUTH === 'absent',
      scrub(resumed)
    )

    // ── Pi on Alibaba: Clave declares the provider, under its own variable ─
    const aliId = await spawn(win, {
      piMode: true,
      launchProfileId: 'e2e-pi-print',
      connectionId: C.ali,
      connectionLabel: 'Alibaba plan',
      model: 'qwen3-coder-plus'
    })
    const ali = await printedBy(win, aliId)
    t.check(
      "the Alibaba value reached the process under Clave's variable",
      ali?.CLAVE === ALIBABA,
      ali ? scrub(ali) : await rawOf(win, aliId)
    )
    t.check('Kimi’s variable is not set on Alibaba', ali?.KIMI === '', scrub(ali))
    t.check(
      'Pi is told --provider clave-alibaba',
      hasPair(ali, '--provider', 'clave-alibaba'),
      scrub(ali?.ARGS)
    )
    t.check(
      'Pi is told --model qwen3-coder-plus',
      hasPair(ali, '--model', 'qwen3-coder-plus'),
      scrub(ali?.ARGS)
    )
    let aliModels = null
    try {
      aliModels = JSON.parse(
        readFileSync(path.join(DIR, 'pi-connections', C.ali, 'models.json'), 'utf8')
      )
    } catch (e) {
      t.check("Alibaba's models.json is readable", false, e.message)
    }
    const aliEntry = aliModels?.providers?.['clave-alibaba']
    t.equal(
      'the clave-alibaba entry carries the coding plan’s base URL',
      aliEntry?.baseUrl,
      'https://coding-intl.dashscope.aliyuncs.com/v1'
    )
    t.equal(
      "the clave-alibaba key is Clave's variable",
      aliEntry?.apiKey,
      '$CLAVE_CONNECTION_API_KEY'
    )
    const aliIds = (aliEntry?.models ?? []).map((m) => m.id)
    t.check('the catalogue’s model is declared', aliIds.includes('qwen3-coder-plus'), aliIds)
    t.check('the deprecated model is not', !aliIds.includes('old-one'), aliIds)

    // ── Pi on Alibaba with no model: the first model listed for it ───────
    // The person's own default is Kimi's, not Alibaba's: the tab starts on
    // the first model the launcher lists for Alibaba, the deprecated one
    // before it skipped (PRDCT-4496).
    const aliDefaultId = await spawn(win, {
      piMode: true,
      launchProfileId: 'e2e-pi-print',
      connectionId: C.ali,
      connectionLabel: 'Alibaba plan'
    })
    const aliDefault = await printedBy(win, aliDefaultId)
    t.check(
      'a Pi tab on Alibaba with no model is told --model qwen3-coder-plus, the first listed',
      hasPair(aliDefault, '--provider', 'clave-alibaba') &&
        hasPair(aliDefault, '--model', 'qwen3-coder-plus'),
      aliDefault ? scrub(aliDefault.ARGS) : await rawOf(win, aliDefaultId)
    )

    // ── Pi on a local Ollama with no model: nothing listed, refused ──────
    const ollamaNoModel = await spawnRefusal(win, {
      piMode: true,
      launchProfileId: 'e2e-pi-print',
      connectionId: C.ollama,
      connectionLabel: 'Local Ollama'
    })
    t.equal(
      'a Pi tab on Ollama with no model is refused in one sentence, never started on something else',
      String(ollamaNoModel ?? '').replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        ''
      ),
      'No model is listed for the connection "Local Ollama": name one to open Pi on it.'
    )

    // ── Pi on a local Ollama: no value, a placeholder the server ignores ──
    const ollamaId = await spawn(win, {
      piMode: true,
      launchProfileId: 'e2e-pi-print',
      connectionId: C.ollama,
      connectionLabel: 'Local Ollama',
      model: 'llama-made-up'
    })
    const ollama = await printedBy(win, ollamaId)
    t.check('Ollama runs on the placeholder key', ollama?.CLAVE === 'ollama', scrub(ollama))
    t.check(
      'Pi is told --provider clave-ollama',
      hasPair(ollama, '--provider', 'clave-ollama'),
      ollama?.ARGS
    )
    let ollamaModels = null
    try {
      ollamaModels = JSON.parse(
        readFileSync(path.join(DIR, 'pi-connections', C.ollama, 'models.json'), 'utf8')
      )
    } catch (e) {
      t.check("Ollama's models.json is readable", false, e.message)
    }
    t.equal(
      'the clave-ollama entry points at the local server the connection stored',
      ollamaModels?.providers?.['clave-ollama']?.baseUrl,
      'http://localhost:11434/v1'
    )

    // ── Pi on no connection: the harness's own login, as today ───────────
    const plainPiId = await spawn(win, { piMode: true, launchProfileId: 'e2e-pi-print' })
    const plainPi = await printedBy(win, plainPiId)
    t.check(
      'a Pi tab on no connection gets no key',
      plainPi?.KIMI === '' && plainPi?.CLAVE === '',
      scrub(plainPi)
    )
    t.equal("a Pi tab on no connection runs in the person's directory", plainPi?.DIR, PI_HOME)
    t.equal("and finds the person's own login there", plainPi?.AUTH, 'present')
    t.check('and is told no provider', !argTokens(plainPi).includes('--provider'), plainPi?.ARGS)

    // ── OpenCode on DeepSeek: its own variable, its configuration, standalone ─
    const dsId = await spawn(win, {
      opencodeMode: true,
      launchProfileId: 'e2e-opencode-print',
      connectionId: C.ds,
      connectionLabel: 'DeepSeek',
      model: 'deepseek-chat'
    })
    const ds = await printedBy(win, dsId)
    t.check(
      'the DeepSeek value reached OpenCode under DEEPSEEK_API_KEY',
      ds?.DS === DEEPSEEK,
      ds ? scrub(ds) : await rawOf(win, dsId)
    )
    let dsConfig = null
    try {
      dsConfig = JSON.parse(ds?.CFG ?? '')
    } catch {
      // Checked below.
    }
    t.equal(
      'OpenCode is handed the provider by its variable and the model',
      JSON.stringify(dsConfig),
      JSON.stringify({
        providers: { deepseek: { settings: { apiKey: '{env:DEEPSEEK_API_KEY}' } } },
        enabled_providers: ['deepseek'],
        model: 'deepseek/deepseek-chat'
      })
    )
    t.equal(
      'OpenCode runs --standalone, once',
      argTokens(ds).filter((a) => a === '--standalone').length,
      1
    )

    // ── OpenCode with a model and no connection: the model alone ─────────
    const ocModelId = await spawn(win, {
      opencodeMode: true,
      launchProfileId: 'e2e-opencode-print',
      model: 'deepseek/deepseek-chat'
    })
    const ocModel = await printedBy(win, ocModelId)
    t.check('OpenCode on no connection gets no key', ocModel?.DS === '', scrub(ocModel))
    t.equal(
      'OpenCode with a model is handed the model alone',
      ocModel?.CFG,
      JSON.stringify({ model: 'deepseek/deepseek-chat' })
    )
    t.equal(
      'and runs --standalone, once',
      argTokens(ocModel).filter((a) => a === '--standalone').length,
      1
    )

    // ── OpenCode with neither: as today ──────────────────────────────────
    const ocPlainId = await spawn(win, {
      opencodeMode: true,
      launchProfileId: 'e2e-opencode-print'
    })
    const ocPlain = await printedBy(win, ocPlainId)
    t.equal('OpenCode with neither is handed no configuration', ocPlain?.CFG, '')
    t.check(
      'and does not run --standalone',
      !!ocPlain && !argTokens(ocPlain).includes('--standalone'),
      ocPlain?.ARGS
    )

    // ── An agent names the connection: clave_open_session's account ───────
    // The window's road (`callMcp` reaches the dispatcher), the account by
    // label, then "any", then a name the store never held. No profile is
    // named: the window's profile list is the one it loaded at start, so main
    // resolves the workspace's Pi profile (`e2e-pi-print`, `setProfiles`).
    const piByLabel = await mcpOpenPrinted(app, {
      mode: 'pi',
      workspace: WS.id,
      account: 'Kimi work',
      name: 'Pi on Kimi by account'
    })
    t.check(
      "an agent's Pi tab on account 'Kimi work' got the Kimi value under KIMI_API_KEY",
      piByLabel.printed?.KIMI === KIMI,
      piByLabel.printed ? scrub(piByLabel.printed) : scrub(piByLabel.raw)
    )
    t.check(
      "and, naming no model, starts on the person's own default as the launcher's tab did: --model k-second",
      hasPair(piByLabel.printed, '--model', 'k-second'),
      piByLabel.printed ? scrub(piByLabel.printed.ARGS) : scrub(piByLabel.raw)
    )
    const piAny = await mcpOpenPrinted(app, {
      mode: 'pi',
      workspace: WS.id,
      account: 'any',
      name: 'Pi on any'
    })
    t.check(
      "account 'any' lands on the first stored connection with a key (Kimi, the listing's first)",
      piAny.printed?.KIMI === KIMI,
      piAny.printed ? scrub(piAny.printed) : scrub(piAny.raw)
    )
    t.check(
      "and on account 'any' too: --model k-second",
      hasPair(piAny.printed, '--model', 'k-second'),
      piAny.printed ? scrub(piAny.printed.ARGS) : scrub(piAny.raw)
    )

    // ── What clave_launch_options says a Pi connection opens on ──────────
    // The Mac's served road: the same rule as the open, so the listing names
    // the model each tab above was handed (PRDCT-4496).
    const listing = await callMcp(app, 'launchOptions', {})
    const piListed = listing?.harnesses?.find((h) => h.id === 'pi')?.connections ?? []
    const startOf = (id) => piListed.find((c) => c.id === id)
    t.check(
      'clave_launch_options says the Kimi connection opens on k-second, as its tabs did',
      startOf(C.kimi)?.startModel === 'k-second',
      startOf(C.kimi) ?? piListed.length
    )
    t.check(
      'the Alibaba connection on qwen3-coder-plus, as its tab did',
      startOf(C.ali)?.startModel === 'qwen3-coder-plus',
      startOf(C.ali) ?? piListed.length
    )
    t.check(
      'and the Ollama connection on none, with the refusal the open says',
      startOf(C.ollama)?.startModel === null &&
        startOf(C.ollama)?.startRefusal ===
          'No model is listed for the connection "Local Ollama": name one to open Pi on it.',
      startOf(C.ollama) ?? piListed.length
    )

    // ── An agent names an OpenCode tab's model (PRDCT-4496) ──────────────
    // The open used to drop it: the tab is handed it in OpenCode's own
    // provider/model form, a model already in that form never prefixed twice.
    const ocByAgent = await mcpOpenPrinted(app, {
      mode: 'opencode',
      chat: false,
      workspace: WS.id,
      account: 'DeepSeek',
      model: 'deepseek-chat',
      name: 'OpenCode on DeepSeek, a model, by an agent'
    })
    t.equal(
      "an agent's OpenCode tab with model deepseek-chat is handed deepseek/deepseek-chat",
      ocByAgent.printed?.MODEL,
      '"model":"deepseek/deepseek-chat"'
    )
    t.equal(
      "on the connection's provider alone",
      ocByAgent.printed?.ENABLED,
      '"enabled_providers":["deepseek"]'
    )
    t.check(
      'on the DeepSeek value',
      ocByAgent.printed?.DS === DEEPSEEK,
      ocByAgent.printed ? scrub(ocByAgent.printed) : scrub(ocByAgent.raw)
    )
    const ocByAgentRef = await mcpOpenPrinted(app, {
      mode: 'opencode',
      chat: false,
      workspace: WS.id,
      account: 'DeepSeek',
      model: 'deepseek/deepseek-chat',
      name: 'OpenCode on DeepSeek, a provider/model, by an agent'
    })
    t.equal(
      'one named deepseek/deepseek-chat is handed it as it is, never prefixed twice',
      ocByAgentRef.printed?.MODEL,
      '"model":"deepseek/deepseek-chat"'
    )
    const ocNoModel = await mcpOpenPrinted(app, {
      mode: 'opencode',
      chat: false,
      workspace: WS.id,
      account: 'DeepSeek',
      name: 'OpenCode on DeepSeek, no model, by an agent'
    })
    t.check(
      "an agent's OpenCode tab with no model is kept on the connection's provider alone, no model named",
      ocNoModel.printed?.ENABLED === '"enabled_providers":["deepseek"]' &&
        ocNoModel.printed?.MODEL === '' &&
        ocNoModel.printed?.DS === DEEPSEEK,
      ocNoModel.printed ? scrub(ocNoModel.printed) : scrub(ocNoModel.raw)
    )

    // ── What the window's clave_list says each of those tabs runs on ──────
    // The daemon's names (PRDCT-4496): mode, model, account, launchProfileId;
    // on a connection the model is its plain id, as the tab was handed it.
    const listedTabs = (await callMcp(app, 'list', {}))?.sessions ?? []
    const rowOf = (id) => listedTabs.find((s) => s.id === id)
    t.check(
      "the window's clave_list names the Pi tab's harness, its model k-second and its connection",
      rowOf(piByLabel.sessionId)?.mode === 'pi' &&
        rowOf(piByLabel.sessionId)?.model === 'k-second' &&
        rowOf(piByLabel.sessionId)?.account?.id === C.kimi &&
        'launchProfileId' in (rowOf(piByLabel.sessionId) ?? {}),
      rowOf(piByLabel.sessionId) ?? 'no row'
    )
    t.check(
      'the OpenCode tab named deepseek-chat by its plain id, on the DeepSeek connection',
      rowOf(ocByAgent.sessionId)?.model === 'deepseek-chat' &&
        rowOf(ocByAgent.sessionId)?.account?.id === C.ds,
      rowOf(ocByAgent.sessionId) ?? 'no row'
    )
    t.check(
      'and the OpenCode tab that named none: model null',
      !!rowOf(ocNoModel.sessionId) && rowOf(ocNoModel.sessionId).model === null,
      rowOf(ocNoModel.sessionId) ?? 'no row'
    )
    // Ended with the spec's own print tabs, so none holds the quit up.
    await win.evaluate(
      (ids) => {
        const out = (window.__connectionsOut ??= {})
        for (const id of ids) out[id] ??= ''
      },
      [
        piByLabel.sessionId,
        piAny.sessionId,
        ocByAgent.sessionId,
        ocByAgentRef.sessionId,
        ocNoModel.sessionId
      ]
    )
    let unknownRefusal = null
    try {
      await callMcp(app, 'openSession', {
        cwd: ROOT,
        mode: 'pi',
        workspace: WS.id,
        account: 'Nobody'
      })
    } catch (e) {
      unknownRefusal = e.message
    }
    t.check(
      'an unknown connection is refused, naming every stored one with its id',
      unknownRefusal?.includes('Unknown Pi connection "Nobody". Available: ') &&
        unknownRefusal.includes(`"Kimi work" (${C.kimi})`) &&
        unknownRefusal.includes(`"Local Ollama" (${C.ollama})`),
      unknownRefusal
    )
    const agentRows = (await callMcp(app, 'list', {}))?.sessions ?? []
    const agentRow = agentRows.find((s) => s.id === piByLabel.sessionId)
    t.check(
      "clave_list reports the agent's Pi tab on 'Kimi work', never exhausted",
      agentRow?.account?.label === 'Kimi work' &&
        agentRow.account.id === C.kimi &&
        agentRow.account.exhausted === false,
      agentRow?.account ?? agentRows.length
    )

    // ── A connection that is gone refuses the start ──────────────────────
    const refused = await spawnRefusal(win, {
      piMode: true,
      launchProfileId: 'e2e-pi-print',
      connectionId: 'c-gone',
      connectionLabel: 'Gone'
    })
    t.check(
      'a spawn on a connection that is gone is refused, naming why',
      refused?.includes('The selected connection is no longer available.'),
      refused
    )
    t.check(
      'c-gone is an id the store never held',
      !Object.values(C).includes('c-gone') && !listedConnections.includes('"c-gone"')
    )

    // ── The settings page: the connections shown, no key on it ──────────
    // Opened the way lane B's spec opens it (`openServersPage`): the footer's
    // usage line, else the Settings button, then the Connections row.
    const usageLine = win.locator('.sidebar-footer-line').first()
    if (await usageLine.count()) await usageLine.click().catch(() => undefined)
    else
      await win
        .getByRole('button', { name: 'Settings', exact: true })
        .click({ timeout: 5000 })
        .catch(() => undefined)
    await win
      .locator('[data-settings-nav-row="accounts"]')
      .click({ timeout: 5000 })
      .catch(() => undefined)
    const accountsPage = win.locator('[data-settings-page="accounts"]')
    const shown = await accountsPage
      .locator(`[data-provider-connection-row="${C.kimi}"]`)
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false
      )
    const settingsText = shown ? await accountsPage.innerText() : ''
    t.check(
      "the settings page lists the Kimi connection and holds no connection's key",
      shown && !holdsValue(settingsText),
      { shown, leaked: holdsValue(settingsText) }
    )

    // ── The person's own Pi files, as they were ──────────────────────────
    for (const [name, text] of Object.entries(PI_FILES)) {
      let now = null
      try {
        now = readFileSync(path.join(PI_HOME, name), 'utf8')
      } catch {
        // Missing: fails below.
      }
      t.check(
        `the person's ${name} is byte-identical`,
        now === text,
        now === null ? 'missing' : scrub(now)
      )
    }

    // ── The value is nowhere but the process ─────────────────────────────
    const leaks = []
    const files = regularFiles(DIR)
    t.check(
      "the walk reads the data folder, the connection's models.json among it",
      files.some((f) => f.file === path.join(kimiDir, 'models.json')),
      files.length
    )
    for (const { file, size } of files) {
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

    const recordsDir = path.join(DIR, 'session-records')
    const records = existsSync(recordsDir)
      ? readdirSync(recordsDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => readFileSync(path.join(recordsDir, f), 'utf8'))
      : []
    const kimiRecord = records.map((r) => JSON.parse(r)).find((r) => r.id === kimiId)
    t.check(
      'the Kimi record names its connection',
      kimiRecord?.connectionId === C.kimi && kimiRecord.connectionLabel === 'Kimi work',
      kimiRecord
        ? { connectionId: kimiRecord.connectionId, connectionLabel: kimiRecord.connectionLabel }
        : records.length
    )
    t.check(
      'no record holds a connection value',
      records.length > 0 && !records.some(holdsValue),
      records.length
    )

    const listed = JSON.stringify(await callMcp(app, 'list', {}))
    t.check('clave_list holds no connection value', !holdsValue(listed))

    const table = execFileSync('ps', ['-axo', 'command'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    t.check('the process table holds no connection value', !holdsValue(table))
    t.check(
      'the print tabs are in the process table (the read above is not empty)',
      table.includes('KIMI=%s'),
      table.length
    )
    // No log check: the harness does not collect main's output, and the
    // child's streams Playwright holds read nothing back here (tried: empty).

    const fixture = await app.evaluate(() => globalThis.__connectionsFixture)
    t.equal('models.dev was never asked: the catalogue came from its cache', fixture.modelsDev, 0)
    t.equal('no renderer exceptions', errors.length, 0)
  } finally {
    await stopTabs(win)
    await app.close()
  }

  // ── The app's own separate server: the two launches that need no connection ─
  writeFixtures(DIR2)
  const separate = await launchApp(DIR2, { server: 'separate', env })
  try {
    await setProfiles(separate.win)
    const ocId = await spawn(separate.win, {
      opencodeMode: true,
      launchProfileId: 'e2e-opencode-print',
      model: 'deepseek/deepseek-chat'
    })
    const oc = await printedBy(separate.win, ocId)
    t.equal(
      'on a separate server, OpenCode with a model is handed the model',
      oc?.CFG,
      JSON.stringify({ model: 'deepseek/deepseek-chat' })
    )
    t.equal(
      'on a separate server, OpenCode runs --standalone once',
      argTokens(oc).filter((a) => a === '--standalone').length,
      1
    )
    const piId = await spawn(separate.win, { piMode: true, launchProfileId: 'e2e-pi-print' })
    const pi = await printedBy(separate.win, piId)
    t.equal(
      "on a separate server, a Pi tab on no connection runs in the person's directory",
      pi?.DIR,
      PI_HOME
    )
    t.equal("and finds the person's own login there", pi?.AUTH, 'present')

    // ── An agent names a connection the separate server stores ───────────
    // Stored through lane B's fleet calls on the window's own machine, which
    // in this mode is the separate server (the calls route to it); the
    // agent's open by label reads that server's list and its spawn that
    // server's key.
    const sepStored = await separate.win.evaluate(async (kimi) => {
      const api = window.electronAPI
      const created = await api.fleetProviderConnectionAdd('local', {
        company: 'moonshot',
        label: 'Kimi work'
      })
      const view = await api.fleetProviderConnectionSetKey('local', created.id, kimi)
      return { id: view.id, hasKey: view.hasKey }
    }, KIMI)
    t.check(
      'on a separate server, the Kimi connection is stored with its key',
      !!sepStored?.id && sepStored.hasKey,
      scrub(sepStored)
    )
    const sepPi = await mcpOpenPrinted(separate.app, {
      mode: 'pi',
      workspace: WS.id,
      account: 'Kimi work',
      name: 'Pi on Kimi by account (separate)'
    })
    await separate.win.evaluate((id) => {
      const out = (window.__connectionsOut ??= {})
      out[id] ??= ''
    }, sepPi.sessionId)
    t.check(
      "on a separate server, an agent's Pi tab on account 'Kimi work' got the Kimi value",
      sepPi.printed?.KIMI === KIMI,
      sepPi.printed ? scrub(sepPi.printed) : scrub(sepPi.raw)
    )
    t.check(
      "and starts on the person's own Pi default there too: --model k-second",
      hasPair(sepPi.printed, '--model', 'k-second'),
      sepPi.printed ? scrub(sepPi.printed.ARGS) : scrub(sepPi.raw)
    )
    // ── What the window's clave_launch_options says there (PRDCT-4496) ───
    // A separate server keeps the connections in its own store: the window's
    // listing names the model the tab above started on, read on that server.
    const sepListing = await callMcp(separate.app, 'launchOptions', {})
    const sepKimi = sepListing?.harnesses
      ?.find((h) => h.id === 'pi')
      ?.connections?.find((c) => c.id === sepStored?.id)
    t.check(
      "on a separate server, the window's clave_launch_options says the Kimi connection opens on k-second, as the tab did",
      sepKimi?.startModel === 'k-second',
      sepKimi ?? 'no Kimi row'
    )
  } finally {
    await stopTabs(separate.win)
    await separate.app.close()
  }
}
