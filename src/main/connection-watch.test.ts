import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { tempDataDir } from './ports/testing'
import { installTerminalPorts, resetTerminalPorts } from './ports/terminals'
import { fileStorage } from './ports/storage'
import {
  connectionReportTime,
  connectionWatchNames,
  ledgerLineForReport,
  parseConnectionReport
} from './connection-watch'
import { UsageLedger } from './usage-ledger'
import { connectionOfRecord, indexLedger, type UsageRecord } from './usage-attribution'
import {
  connectionReportPath,
  lastConnectionReport,
  setConnectionReportListener,
  startWatching,
  stopWatching
} from './agent-state-manager'
import {
  listedProviderConnection,
  providerConnectionLeft
} from '../shared/provider-connection-pick'
import { servedAccountOf } from './mcp/provider-launch-listing'
import { piRequestLeftConnection } from './sessions/adapters/pi-rpc-adapter'
import { sessionConnection, sessionConnectionLeft } from '../renderer/src/lib/session-connection'

/**
 * A Pi tab that leaves its stored connection stops naming it (PRDCT-4540):
 * what Clave's extension is told and reports, how the state folder's watch
 * reads the report, and the one rule that names the connection or says the
 * tab left it, for the window and for `clave_list`.
 */

const KEY = 'made-up-connection-key-4540'
const THROWS = Symbol('throws')
const MISSING = Symbol('missing')
const dirs: string[] = []
afterEach(() => {
  resetTerminalPorts()
  setConnectionReportListener(null)
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('what the extension is told: names, never a value', () => {
  it('the provider and the one variable of the key', () => {
    expect(
      connectionWatchNames('kimi-coding', { KIMI_API_KEY: KEY, PI_CODING_AGENT_DIR: '/x' })
    ).toEqual({
      CLAVE_CONNECTION_PROVIDER: 'kimi-coding',
      CLAVE_CONNECTION_KEY_VAR: 'KIMI_API_KEY'
    })
    expect(
      JSON.stringify(connectionWatchNames('kimi-coding', { KIMI_API_KEY: KEY }))
    ).not.toContain(KEY)
  })
  it('a connection with no key is watched by its provider; no provider, nothing', () => {
    expect(connectionWatchNames('clave-ollama', { PI_CODING_AGENT_DIR: '/x' })).toEqual({
      CLAVE_CONNECTION_PROVIDER: 'clave-ollama'
    })
    expect(connectionWatchNames(undefined, { A_KEY: KEY })).toBeNull()
    expect(connectionWatchNames('bad provider', { A_KEY: KEY })).toBeNull()
  })
  it('the report reads as on, off with a provider, or nothing', () => {
    expect(parseConnectionReport('on\n')).toBeNull()
    expect(parseConnectionReport('off other-provider\n')).toBe('other-provider')
    expect(parseConnectionReport('off kimi-coding credential\n')).toBe('kimi-coding credential')
    expect(parseConnectionReport('unchecked kimi-coding\n')).toBe('kimi-coding unchecked')
    expect(parseConnectionReport('off ')).toBeUndefined()
    expect(parseConnectionReport('off a b')).toBeUndefined()
    expect(parseConnectionReport('unchecked a credential')).toBeUndefined()
    expect(parseConnectionReport('')).toBeUndefined()
    expect(parseConnectionReport(null)).toBeUndefined()
  })
  it('the time on a line is read beside its words; a line without one reads as before', () => {
    expect(parseConnectionReport('on at 1794675520700\n')).toBeNull()
    expect(connectionReportTime('on at 1794675520700\n')).toBe(1794675520700)
    expect(parseConnectionReport('off other at 12\n')).toBe('other')
    expect(connectionReportTime('off other at 12\n')).toBe(12)
    expect(parseConnectionReport('off kimi-coding credential at 12')).toBe('kimi-coding credential')
    expect(parseConnectionReport('unchecked kimi-coding at 12')).toBe('kimi-coding unchecked')
    // A provider id that is the word itself.
    expect(parseConnectionReport('off at at 12')).toBe('at')
    expect(connectionReportTime('off at at 12')).toBe(12)
    // No time: an older extension's line.
    expect(parseConnectionReport('off other\n')).toBe('other')
    expect(connectionReportTime('off other\n')).toBeUndefined()
    expect(connectionReportTime('on')).toBeUndefined()
    // A time on a line that does not read, or a time that is not one.
    expect(connectionReportTime('garbage at 12')).toBeUndefined()
    expect(connectionReportTime('on at 0')).toBeUndefined()
    expect(parseConnectionReport('on at -1')).toBeUndefined()
    expect(parseConnectionReport('on at 12 at 13')).toBeUndefined()
  })
})

/** Clave's Pi extension against a made-up `pi` and a made-up request. */
interface ExtensionModule {
  watchConnection: (
    pi: unknown,
    env: Record<string, string | undefined>,
    now?: () => number
  ) => boolean
}
const extension = (): Promise<ExtensionModule> =>
  import(
    pathToFileURL(path.resolve(__dirname, '..', '..', 'resources', 'pi-clave-state.js')).href
  ) as Promise<ExtensionModule>

function watched(
  env: Record<string, string | undefined>,
  now?: () => number
): {
  request: (
    mode: 'rpc' | 'tui',
    provider: string,
    apiKey: string | undefined | typeof THROWS | typeof MISSING,
    how?: { api?: string; registered?: string[] | typeof MISSING }
  ) => Promise<boolean>
  /** The report's words, its time left out. */
  report: () => string | null
  /** The report as written. */
  raw: () => string | null
  watching: boolean
} {
  const raw = (): string | null =>
    env.CLAVE_CONNECTION_REPORT_FILE && fs.existsSync(env.CLAVE_CONNECTION_REPORT_FILE)
      ? fs.readFileSync(env.CLAVE_CONNECTION_REPORT_FILE, 'utf8')
      : null
  const handlers: ((event: unknown, ctx: unknown) => Promise<void>)[] = []
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
      if (event === 'before_provider_headers') handlers.push(handler)
    }
  }
  let watching = false
  const ready = extension().then((mod) => {
    watching = mod.watchConnection(pi, env, now)
  })
  return {
    get watching() {
      return watching
    },
    request: async (mode, provider, apiKey, how = {}) => {
      await ready
      let aborted = false
      // `THROWS`: the call throws; `MISSING`: a Pi with no getProviderAuth.
      // As Pi 1.5.2: a physical model's api, and the provider ids extensions
      // registered (Pi's own bundled `llama.cpp` among them).
      const registered = how.registered ?? ['llama.cpp']
      const ctx = {
        mode,
        model: { provider, id: 'm', api: how.api ?? 'openai-completions' },
        modelRegistry:
          apiKey === MISSING
            ? {}
            : {
                getProviderAuth: async () => {
                  if (apiKey === THROWS) throw new Error('made-up failure')
                  return { auth: { apiKey }, source: 'x' }
                },
                ...(registered === MISSING
                  ? {}
                  : { getRegisteredProviderIds: () => registered })
              },
        abort: () => {
          aborted = true
        }
      }
      for (const handler of handlers) await handler({ type: 'before_provider_headers' }, ctx)
      return aborted
    },
    report: () => raw()?.replace(/ at \d+\n$/, '\n') ?? null,
    raw
  }
}

describe("Clave's Pi extension watches each request of a tab on a connection", () => {
  const envFor = (): Record<string, string> => {
    const dir = tempDataDir('clave-watch-')
    dirs.push(dir)
    return {
      CLAVE_CONNECTION_PROVIDER: 'conn',
      CLAVE_CONNECTION_KEY_VAR: 'CONN_KEY',
      CONN_KEY: KEY,
      CLAVE_CONNECTION_REPORT_FILE: path.join(dir, 'tab.connection')
    }
  }

  it('a request on the connection reports on and goes', async () => {
    const tab = watched(envFor())
    expect(await tab.request('rpc', 'conn', KEY)).toBe(false)
    expect(tab.report()).toBe('on\n')
  })

  it('a request to another provider: off with its id; ended in a chat, reported only in a terminal', async () => {
    const chat = watched(envFor())
    expect(await chat.request('rpc', 'other', 'made-up-other')).toBe(true)
    expect(chat.report()).toBe('off other\n')
    const terminal = watched(envFor())
    expect(await terminal.request('tui', 'other', 'made-up-other')).toBe(false)
    expect(terminal.report()).toBe('off other\n')
  })

  it('the same provider with another credential (a /login in the tab) is off it too', async () => {
    const chat = watched(envFor())
    expect(await chat.request('rpc', 'conn', 'made-up-login-key')).toBe(true)
    expect(chat.report()).toBe('off conn credential\n')
    expect(await chat.request('rpc', 'conn', undefined)).toBe(true)
  })

  it('when it cannot tell which credential, it says so: unchecked, ended in a chat, reported in a terminal', async () => {
    const chat = watched(envFor())
    expect(await chat.request('rpc', 'conn', THROWS)).toBe(true)
    expect(chat.report()).toBe('unchecked conn\n')
    const terminal = watched(envFor())
    expect(await terminal.request('tui', 'conn', MISSING)).toBe(false)
    expect(terminal.report()).toBe('unchecked conn\n')
  })

  it("a virtual model under the connection's provider is not known to be on it: unchecked, ended in a chat, reported in a terminal", async () => {
    // Pi 1.5.2: `ctx.model` is the SELECTED virtual model (api `pi-virtual`),
    // listed under the connection's provider; its router sends elsewhere,
    // and the credential Pi resolves for the listed provider is the
    // connection's own.
    const virtual = { api: 'pi-virtual' }
    const chat = watched(envFor())
    expect(await chat.request('rpc', 'conn', KEY, virtual)).toBe(true)
    expect(chat.report()).toBe('unchecked conn\n')
    const terminal = watched(envFor())
    expect(await terminal.request('tui', 'conn', KEY, virtual)).toBe(false)
    expect(terminal.report()).toBe('unchecked conn\n')
    // Under another provider id too: where it goes is unknown, not that id.
    const elsewhere = watched(envFor())
    expect(await elsewhere.request('rpc', 'router', undefined, virtual)).toBe(true)
    expect(elsewhere.report()).toBe('unchecked router\n')
    // A keyless connection is no exception.
    const keyless: Record<string, string | undefined> = { ...envFor() }
    delete keyless.CLAVE_CONNECTION_KEY_VAR
    const local = watched(keyless)
    expect(await local.request('rpc', 'conn', undefined, virtual)).toBe(true)
    expect(local.report()).toBe('unchecked conn\n')
  })

  it("the connection's provider registered again by an extension is not known to be on it", async () => {
    const chat = watched(envFor())
    expect(await chat.request('rpc', 'conn', KEY, { registered: ['llama.cpp', 'conn'] })).toBe(
      true
    )
    expect(chat.report()).toBe('unchecked conn\n')
    const terminal = watched(envFor())
    expect(await terminal.request('tui', 'conn', KEY, { registered: ['conn'] })).toBe(false)
    expect(terminal.report()).toBe('unchecked conn\n')
    // A Pi that cannot say which ids extensions registered: not checked.
    const older = watched(envFor())
    expect(await older.request('rpc', 'conn', KEY, { registered: MISSING })).toBe(true)
    expect(older.report()).toBe('unchecked conn\n')
    // Another provider's registration changes nothing for the connection.
    const fine = watched(envFor())
    expect(await fine.request('rpc', 'conn', KEY, { registered: ['llama.cpp', 'other'] })).toBe(
      false
    )
    expect(fine.report()).toBe('on\n')
  })

  it('a key variable named but empty or absent is no check: unchecked, ended in a chat', async () => {
    for (const value of ['', undefined]) {
      const env: Record<string, string | undefined> = { ...envFor(), CONN_KEY: value }
      const chat = watched(env)
      expect(await chat.request('rpc', 'conn', 'made-up-login-key')).toBe(true)
      expect(chat.report()).toBe('unchecked conn\n')
      const terminal = watched({ ...env })
      expect(await terminal.request('tui', 'conn', 'made-up-login-key')).toBe(false)
      expect(terminal.report()).toBe('unchecked conn\n')
    }
  })

  it('a connection with no key (no variable named) is watched by its provider alone', async () => {
    const env: Record<string, string | undefined> = { ...envFor() }
    delete env.CLAVE_CONNECTION_KEY_VAR
    const tab = watched(env)
    expect(await tab.request('rpc', 'conn', undefined)).toBe(false)
    expect(tab.report()).toBe('on\n')
    expect(await tab.request('rpc', 'other', undefined)).toBe(true)
    expect(tab.report()).toBe('off other\n')
  })

  it('writes when the answer changes, back to on when a request goes on it again', async () => {
    const env = envFor()
    const tab = watched(env)
    await tab.request('tui', 'other', 'x')
    fs.writeFileSync(env.CLAVE_CONNECTION_REPORT_FILE, 'marker')
    await tab.request('tui', 'other', 'x')
    expect(tab.report()).toBe('marker')
    await tab.request('tui', 'conn', KEY)
    expect(tab.report()).toBe('on\n')
  })

  it('never writes the value, whatever the request', async () => {
    const env = envFor()
    const tab = watched(env)
    for (const [provider, key] of [
      ['conn', KEY],
      ['other', KEY],
      ['conn', 'made-up-login-key']
    ] as const) {
      await tab.request('rpc', provider, key)
      expect(tab.report()).not.toContain(KEY)
      expect(tab.report()).not.toContain('made-up-login-key')
    }
  })

  it('each line carries the time the process decided, before the request left (PRDCT-4551)', async () => {
    let clock = 1794675520700.6
    const env = envFor()
    const tab = watched(env, () => clock)
    await tab.request('tui', 'conn', KEY)
    expect(tab.raw()).toBe('on at 1794675520700\n')
    clock = 1794675521000
    await tab.request('tui', 'other', 'made-up-other')
    expect(tab.raw()).toBe('off other at 1794675521000\n')
    // The same answer again: no line, so the time of the change stays.
    clock = 1794675522000
    await tab.request('tui', 'other', 'made-up-other')
    expect(tab.raw()).toBe('off other at 1794675521000\n')
    clock = 1794675523000
    await tab.request('rpc', 'conn', 'made-up-login-key')
    expect(tab.raw()).toBe('off conn credential at 1794675523000\n')
    // Read by Clave's watch as the words and the time.
    expect(parseConnectionReport(tab.raw())).toBe('conn credential')
    expect(connectionReportTime(tab.raw())).toBe(1794675523000)
  })

  it('without a clock given, the line carries the process time of the decision', async () => {
    const tab = watched(envFor())
    const before = Date.now()
    await tab.request('rpc', 'conn', KEY)
    const at = connectionReportTime(tab.raw())
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('a tab on no connection is told nothing and does nothing', async () => {
    const tab = watched({ CONN_KEY: KEY })
    expect(await tab.request('rpc', 'other', 'x')).toBe(false)
    expect(tab.watching).toBe(false)
  })
})

describe("the state folder's watch reads a tab's report (PRDCT-4540)", () => {
  it('forwards a change once: off with the provider, then on as null', () => {
    const dir = tempDataDir('clave-watch-state-')
    dirs.push(dir)
    installTerminalPorts({ storage: fileStorage(dir) })
    const heard: [string, string | null][] = []
    setConnectionReportListener((id, leftFor) => heard.push([id, leftFor]))
    const file = connectionReportPath('tab-1')
    expect(path.dirname(file)).toBe(path.join(dir, 'agent-state'))
    fs.writeFileSync(file, 'off other\n')
    lastConnectionReport('tab-1')
    lastConnectionReport('tab-1')
    fs.writeFileSync(file, 'garbage')
    lastConnectionReport('tab-1')
    fs.writeFileSync(file, 'on\n')
    lastConnectionReport('tab-1')
    expect(heard).toEqual([
      ['tab-1', 'other'],
      ['tab-1', null]
    ])
  })

  it("forwards the line's time when the folder's watch sees it; none for a line without one, nor for a tab taken back", async () => {
    const dir = tempDataDir('clave-watch-time-')
    dirs.push(dir)
    installTerminalPorts({ storage: fileStorage(dir) })
    const heard: [string, string | null, number | undefined][] = []
    setConnectionReportListener((id, leftFor, at) => heard.push([id, leftFor, at]))
    startWatching(() => {})
    try {
      const file = connectionReportPath('tab-2')
      const heardFor = async (n: number): Promise<void> => {
        for (let i = 0; i < 200 && heard.length < n; i++)
          await new Promise((resolve) => setTimeout(resolve, 10))
      }
      fs.writeFileSync(file, 'off other at 1794675520788\n')
      await heardFor(1)
      fs.writeFileSync(file, 'on\n')
      await heardFor(2)
      expect(heard).toEqual([
        ['tab-2', 'other', 1794675520788],
        ['tab-2', null, undefined]
      ])
      // A tab this process takes back: its last line holds from now on.
      fs.writeFileSync(connectionReportPath('tab-3'), 'off other at 1794675520788\n')
      lastConnectionReport('tab-3')
      expect(heard.find(([id]) => id === 'tab-3')).toEqual(['tab-3', 'other', undefined])
    } finally {
      stopWatching()
    }
  })
})

describe('the one rule: a tab off its connection names it nowhere and says so (PRDCT-4540)', () => {
  const on = { piMode: true, connectionId: 'c1', connectionLabel: 'Kimi' }
  const off = { ...on, connectionLeftFor: 'anthropic' }
  const sentence = "Pi runs on anthropic now, not on this tab's connection."

  it('for clave_list on a Clave server and on the Mac', () => {
    expect(listedProviderConnection(on, () => undefined)).toEqual({
      id: 'c1',
      label: 'Kimi',
      exhausted: false
    })
    expect(listedProviderConnection(off, () => undefined)).toBeNull()
    expect(providerConnectionLeft(off)).toBe(sentence)
    expect(providerConnectionLeft(on)).toBeNull()
    const reads = {
      accountLabel: () => undefined,
      exhausted: () => false,
      providerConnectionLabel: () => 'Kimi'
    }
    type Served = Parameters<typeof servedAccountOf>[0]
    expect(servedAccountOf(off as unknown as Served, reads)).toBeNull()
    expect(servedAccountOf(on as unknown as Served, reads)).toMatchObject({ id: 'c1' })
  })

  it("for the window's header, foot and row menu", () => {
    expect(sessionConnection({ id: 's', ...on }, {})).toEqual({ id: 'c1', label: 'Kimi' })
    expect(sessionConnection({ id: 's', ...off }, {})).toBeNull()
    expect(sessionConnectionLeft({ id: 's', ...off })).toBe(sentence)
    expect(sessionConnectionLeft({ id: 's', ...on })).toBeNull()
  })

  it('a tab on no connection, or a report naming no valid provider, says nothing', () => {
    expect(providerConnectionLeft({ piMode: true, connectionLeftFor: 'x' })).toBeNull()
    expect(providerConnectionLeft({ ...on, connectionLeftFor: 'a b' })).toBeNull()
  })

  it('the sign-in road names what changed: the credential, not the provider', () => {
    const left = { ...on, connectionLeftFor: 'kimi-coding credential' }
    const said =
      "Pi runs on kimi-coding with another credential now, not with this tab's connection."
    expect(providerConnectionLeft(left)).toBe(said)
    expect(sessionConnectionLeft({ id: 's', ...left })).toBe(said)
    expect(listedProviderConnection(left, () => undefined)).toBeNull()
  })

  it('a credential Clave could not check says so, never that Pi left', () => {
    const left = { ...on, connectionLeftFor: 'kimi-coding unchecked' }
    const said =
      'Clave could not check which credential Pi uses now, so this tab no longer names its connection.'
    expect(providerConnectionLeft(left)).toBe(said)
    expect(sessionConnectionLeft({ id: 's', ...left })).toBe(said)
    expect(listedProviderConnection(left, () => undefined)).toBeNull()
  })
})

describe('usage follows the report (PRDCT-4540 with PRDCT-4551)', () => {
  const record = {
    piMode: true,
    piSessionId: 'pi-session-1',
    connectionId: 'c1',
    connectionLabel: 'Kimi'
  }
  it('off: a line with no connection; on: a line with the connection', () => {
    expect(ledgerLineForReport(record, 'kimi-coding credential')).toEqual({
      harness: 'pi',
      sessionId: 'pi-session-1',
      connectionId: null,
      label: null
    })
    expect(ledgerLineForReport(record, null)).toEqual({
      harness: 'pi',
      sessionId: 'pi-session-1',
      connectionId: 'c1',
      label: 'Kimi'
    })
    expect(ledgerLineForReport({ ...record, connectionId: undefined }, 'x')).toBeNull()
    expect(ledgerLineForReport({ ...record, piSessionId: undefined }, 'x')).toBeNull()
    expect(ledgerLineForReport(null, null)).toBeNull()
  })

  it('a record written while the tab is off is counted to the sign-in, the sign-in road included', () => {
    const dir = tempDataDir('clave-watch-ledger-')
    dirs.push(dir)
    let now = 1000
    const ledger = new UsageLedger(
      () => fileStorage(dir),
      () => now
    )
    const write = (leftFor: string | null, at: number): void => {
      now = at
      const line = ledgerLineForReport(record, leftFor)!
      ledger.record({ ...line, company: line.connectionId ? 'moonshot' : null })
    }
    write(null, 1000) // the start, on the connection
    write('kimi-coding credential', 2000) // a /login: the same provider
    write('kimi-coding credential', 2500) // the same answer: nothing written
    write(null, 3000) // back on it
    expect(ledger.read().map((l) => [l.at, l.connectionId])).toEqual([
      [1000, 'c1'],
      [2000, null],
      [3000, 'c1']
    ])
    const index = indexLedger(ledger.read())
    const providerOf = (): string => 'kimi-coding'
    const usage = (at: number): UsageRecord => ({
      harness: 'pi',
      sessionId: 'pi-session-1',
      at,
      provider: 'kimi-coding',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: 0
    })
    expect(connectionOfRecord(index, usage(1500), providerOf)).toBe('c1')
    expect(connectionOfRecord(index, usage(2200), providerOf)).toBeNull()
    expect(connectionOfRecord(index, usage(3100), providerOf)).toBe('c1')
  })
})

describe("the chat's sentence for each road (PRDCT-4540)", () => {
  it('another provider, another credential, a credential not checked', () => {
    expect(piRequestLeftConnection('Pi', 'anthropic', 'kimi-coding')).toBe(
      "Pi was about to send this turn to anthropic, not to this chat's connection (kimi-coding): nothing was sent, and the turn ended."
    )
    expect(piRequestLeftConnection('Pi', 'kimi-coding credential', 'kimi-coding')).toBe(
      "Pi was about to send this turn to kimi-coding with another credential than this chat's connection: nothing was sent, and the turn ended."
    )
    expect(piRequestLeftConnection('Pi', 'kimi-coding unchecked', 'kimi-coding')).toBe(
      'Clave could not check which credential this turn would use: nothing was sent, and the turn ended.'
    )
  })
})
