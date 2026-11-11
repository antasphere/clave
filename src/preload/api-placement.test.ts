import { describe, expect, it, vi } from 'vitest'
import { resourceKey, sessionKey } from '@clave/contract/fleet'
import type { Backing } from '@clave/client/router'
import { API_PLACEMENT } from './api-placement'

/**
 * The declaration held to the REAL exposed API (PRDCT-4329): the preload is
 * loaded as the window loads it, the object it hands `contextBridge` is
 * enumerated, and the bridge `createFleetDesktop` was given is kept beside it,
 * so the test sees which members the wrapper overrides. No hand-kept list: a
 * member added to `index.ts` or to the wrapper with no entry fails here.
 */
const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  local: null as Record<string, unknown> | null
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: {
    invoke: vi.fn(async () => null),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  webUtils: {}
}))
vi.mock('./fleet-desktop', async (importOriginal) => {
  const real = await importOriginal<typeof import('./fleet-desktop')>()
  return {
    ...real,
    createFleetDesktop: (...args: Parameters<typeof real.createFleetDesktop>) => {
      mocks.local ??= args[0] as unknown as Record<string, unknown>
      return real.createFleetDesktop(...args)
    }
  }
})
await import('./index')
const { createFleetDesktop } = await import('./fleet-desktop')

const exposed = mocks.exposed.get('electronAPI') as Record<string, unknown>
const local = mocks.local as Record<string, unknown>

type Member = { name: string; value: unknown; localValue: unknown; inLocal: boolean }
/** Every member of the exposed API, a namespace's as `namespace.member`.
 *  A plain value (`platform`) is a member too. */
const members = (): Member[] => {
  const out: Member[] = []
  for (const [name, value] of Object.entries(exposed)) {
    if (value && typeof value === 'object') {
      const own = (local[name] ?? {}) as Record<string, unknown>
      for (const [sub, subValue] of Object.entries(value))
        out.push({
          name: `${name}.${sub}`,
          value: subValue,
          localValue: own[sub],
          inLocal: sub in own
        })
    } else out.push({ name, value, localValue: local[name], inLocal: name in local })
  }
  return out
}

/** Parameters that name a session, a folder or a file: a `local` member that
 *  takes one must say why it is right on this Mac. Read off the bridge's own
 *  source; a `viaServer` member reads as `(...args)` and is judged by hand. */
/** The `local` members whose parameters cannot be read off their source
 *  (built by `viaServer` / `viaSidebar`, they read as `(...args)`), judged by
 *  hand: each is in exactly one of the two lists, and a new one in neither
 *  fails the test. Those that take a session id, a cwd or a path (or a tab's
 *  or a group's id) must carry a `why`. */
const UNREADABLE_TAKES_PLACE = new Set([
  'sessionsControl',
  'sessionsChangeWork',
  'windowMoveSessions',
  'windowMoveGroup',
  'pluginsInvokeAction',
  'pluginsPreviewAction',
  'sidebarLayoutSave'
])
const UNREADABLE_NO_PLACE = new Set([
  'pluginsList',
  'pluginsViewRequest',
  'pluginsEnable',
  'pluginsDisable',
  'pluginsRemove',
  'pluginsCommand',
  'pluginsSecrets',
  'pluginsSecretReply',
  'launchProfilesList',
  'launchProfileUpsert',
  'launchProfileDelete',
  'launchProfileSetGlobal',
  'launchProfileSetWorkspace',
  'helpersList',
  'helperSet',
  'routinesList',
  'routinesRunNow',
  'routinesDismiss',
  'routinesOpenDiscussion',
  'routinesCreate',
  'routinesUpdate',
  'routinesDelete',
  'routinesPause',
  'sidebarLayoutLoad',
  'workspaceLoad',
  'workspaceUpdateRegistry',
  'workspaceUpdatePins',
  'workspaceSetLastActive',
  'getUsageLimits',
  'getClaudeUsageSnapshot',
  'claudeAccountsList',
  'claudeAccountsMigrated',
  'claudeAccountAdd',
  'claudeAccountUpdate',
  'claudeAccountReorder',
  'claudeAccountRemove',
  'claudeAccountSetToken',
  'claudeAccountClearToken',
  'codexAccountsList',
  'codexAccountAdd',
  'codexAccountUpdate',
  'codexAccountReorder',
  'codexAccountRemove',
  'codexAccountClearCredential',
  'accountLoginStart',
  'accountLoginApiKey',
  'accountLoginInput',
  'accountLoginCancel',
  'accountLoginList',
  'antasphereAccountGet',
  'antasphereAccountDismiss',
  'getCodexUsageLimits',
  'getCodexUsageSnapshot',
  'getPiUsage'
])
const unreadable = (fn: unknown): boolean => {
  if (typeof fn !== 'function') return false
  const head = Function.prototype.toString
    .call(fn)
    .match(/^(?:async\s*)?(?:function\s*\w*)?\s*\(([^)]*)\)/)?.[1]
  return head === undefined || head.includes('...')
}

const PLACE_PARAMS =
  /^(sessionId|sessionIds|cwd|rootCwd|path|paths|filePath|dirPath|fullPath|sourcePath|absolutePath|defaultPath|folder|parent|target|configDir)$/
const paramsOf = (fn: unknown): string[] => {
  if (typeof fn !== 'function') return []
  const source = Function.prototype.toString.call(fn)
  const head = source.match(/^(?:async\s*)?(?:function\s*\w*)?\s*\(([^)]*)\)/)?.[1] ?? ''
  return head
    .split(',')
    .map((p) =>
      p
        .trim()
        .replace(/[=:].*$/, '')
        .replace(/^\.\.\./, '')
        .trim()
    )
    .filter(Boolean)
}

describe('every member of the exposed API declares where it runs for a server tab', () => {
  it('finds the API (the mock saw the bridge and the wrapper)', () => {
    expect(local).toBeTruthy()
    expect(members().length).toBeGreaterThan(300)
  })

  it('declares every member, and declares nothing that is not a member', () => {
    const names = members().map((m) => m.name)
    const undeclared = names.filter((n) => !(n in API_PLACEMENT))
    const stale = Object.keys(API_PLACEMENT).filter((n) => !names.includes(n))
    expect({ undeclared, stale }).toEqual({ undeclared: [], stale: [] })
  })

  it('says routed or refused exactly where the wrapper overrides this Mac’s member', () => {
    const wrong: string[] = []
    for (const m of members()) {
      const declared = API_PLACEMENT[m.name]
      if (!declared || !m.inLocal) continue // the wrapper's own (fleet*) members
      const overridden = m.value !== m.localValue
      if (declared.placement === 'local' && overridden)
        wrong.push(`${m.name}: declared local, the wrapper overrides it`)
      if (declared.placement !== 'local' && !overridden)
        wrong.push(`${m.name}: declared ${declared.placement}, runs on this Mac`)
    }
    expect(wrong).toEqual([])
  })

  it('a member only the wrapper has (fleet*) is never declared refused', () => {
    const wrong = members()
      .filter((m) => !m.inLocal && API_PLACEMENT[m.name]?.placement === 'refused-for-remote')
      .map((m) => m.name)
    expect(wrong).toEqual([])
  })

  it('a refusal says why, and so does every local member that takes a session, a cwd or a path', () => {
    const silent: string[] = []
    for (const m of members()) {
      const declared = API_PLACEMENT[m.name]
      if (!declared) continue
      if (declared.placement === 'refused-for-remote' && !declared.why) silent.push(m.name)
      if (declared.wrongForServerTab && !declared.why) silent.push(m.name)
      if (declared.placement !== 'local' || declared.why) continue
      const place = paramsOf(m.localValue).filter((p) => PLACE_PARAMS.test(p))
      if (place.length > 0) silent.push(`${m.name}(${place.join(', ')})`)
    }
    expect(silent).toEqual([])
  })

  it('the digest members go to the server a tab runs on (PRDCT-4327), Folio’s reads too', () => {
    for (const name of [
      'exchangeDigest',
      'exchangeDigestsOf',
      'workDigest',
      'workDigestsOf',
      'spokenRendering',
      'spokenRenderingsOf',
      'pageTitle',
      'pageTitlesOf'
    ])
      expect(API_PLACEMENT[name]).toEqual({ placement: 'routed' })
  })
})

describe('a member whose parameters cannot be read is judged by hand', () => {
  it('each such local member is in exactly one list, and one that takes a place says why', () => {
    const wrong: string[] = []
    for (const m of members()) {
      const declared = API_PLACEMENT[m.name]
      if (!m.inLocal || declared?.placement !== 'local' || !unreadable(m.localValue)) continue
      const takes = UNREADABLE_TAKES_PLACE.has(m.name)
      const free = UNREADABLE_NO_PLACE.has(m.name)
      if (takes === free) wrong.push(`${m.name}: in ${takes ? 'both lists' : 'neither list'}`)
      if (takes && !declared.why) wrong.push(`${m.name}: takes a place and says no why`)
    }
    for (const name of [...UNREADABLE_TAKES_PLACE, ...UNREADABLE_NO_PLACE])
      if (API_PLACEMENT[name]?.placement !== 'local') wrong.push(`${name}: listed, not local`)
    expect(wrong).toEqual([])
  })
})

/**
 * `routed` and `refused-for-remote` told apart by what the member DOES with
 * a server's key: the wrapper is built over a bridge that records every call
 * and a server whose every API and push method records that it was reached.
 * A routed member reaches the server for one of the argument shapes below; a
 * refused one never does, whatever it is given. Listeners (`on*`) bind on
 * the push channel at connect time and are held by the identity test above.
 */
describe('routed reaches the server a key names; refused never does', () => {
  const S = sessionKey({ serverId: 'x', sessionId: 's1' })
  const F = resourceKey('file', 'x', '/srv/a')
  const G = resourceKey('group', 'x', 'g1')
  const reached: Array<{ path: string; args: unknown[] }> = []
  // A value that is whatever the caller reads it as: an empty list, an
  // object of more of itself, a function answering itself; never a promise.
  const anything: unknown = new Proxy(
    function target() {
      return undefined
    },
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        if (prop === Symbol.iterator) return () => [][Symbol.iterator]()
        if (prop === Symbol.toPrimitive) return () => ''
        if (typeof prop === 'string' && prop in Array.prototype)
          return (Array.prototype as unknown as Record<string, unknown>)[prop] instanceof Function
            ? (...a: unknown[]) =>
                (Array.prototype as unknown as Record<string, (...b: unknown[]) => unknown>)[
                  prop
                ].apply([], a)
            : 0
        return anything
      },
      apply: () => anything
    }
  )
  // The few answers a later member reads back: an attachment the server
  // prepared is what its preview is asked about.
  const ATTACHMENT = '/srv/attachments/s1/a.txt'
  const ANSWERS: Record<string, unknown> = {
    'api.files.prepareAttachment': { id: 'a1', path: ATTACHMENT, name: 'a.txt', size: 1 }
  }
  const recorder = (path: string): unknown =>
    new Proxy(
      function target() {
        return undefined
      },
      {
        get: (_t, prop) => (prop === 'then' ? undefined : recorder(`${path}.${String(prop)}`)),
        apply: (_t, _this, args: unknown[]) => {
          reached.push({ path, args })
          return Promise.resolve(ANSWERS[path] ?? anything)
        }
      }
    )
  const localCalls: string[] = []
  const stub: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(local)) {
    if (value && typeof value === 'object')
      stub[name] = Object.fromEntries(
        Object.keys(value).map((sub) => [
          sub,
          (): Promise<unknown> => {
            localCalls.push(`${name}.${sub}`)
            return Promise.resolve(anything)
          }
        ])
      )
    else if (typeof value === 'function')
      stub[name] = (): unknown => {
        localCalls.push(name)
        return Promise.resolve(anything)
      }
    else stub[name] = value
  }
  const push = {
    status: 'open',
    connect: () => {},
    close: () => {},
    onRequest: () => () => {},
    whenOpen: () => Promise.resolve(),
    onStatus: () => () => {},
    onEvent: () => () => {},
    subscribe: (...a: unknown[]) => (recorder('push.subscribe') as (...b: unknown[]) => void)(...a),
    subscribed: (...a: unknown[]) =>
      (recorder('push.subscribed') as (...b: unknown[]) => Promise<unknown>)(...a)
  }
  const wrapped = createFleetDesktop(stub as never, {
    invoke: async (channel: string) =>
      channel === 'server:fleet:list'
        ? [{ id: 'x', name: 'Server x', enabled: true, url: 'http://x' }]
        : channel === 'server:fleet:endpoint'
          ? { url: 'http://x', token: 'test-only' }
          : anything,
    changed: () => () => {},
    connect: async () => {
      // The fleet's own reads at connect (the snapshot, the requests, the
      // routines, the workspaces) are not a member's: they answer quietly.
      const quiet = {
        dispose: async () => {},
        sessions: { list: async () => [], listAdoptable: async () => [] },
        sidebar: {
          getLayout: async () => ({
            windowKey: 'server',
            revision: 0,
            groups: [],
            displayOrder: []
          })
        },
        requests: { watch: () => () => {} },
        routines: { list: async () => ({ routines: [], runs: [] }) }
      }
      const quietly = (path: string, target: Record<string, unknown>): unknown =>
        new Proxy(target, {
          get: (t, prop) => {
            if (prop === 'then') return undefined
            const own = t[prop as string]
            if (own === undefined) return recorder(`${path}.${String(prop)}`)
            return typeof own === 'object' && own !== null
              ? quietly(`${path}.${String(prop)}`, own as Record<string, unknown>)
              : own
          }
        })
      return { api: quietly('api', quiet), push } as unknown as Backing
    }
  }) as unknown as Record<string, unknown>
  const shapes: unknown[][] = [
    [S, anything, anything, anything],
    [S, {}, anything],
    [F, '/srv/a/b', anything, anything],
    [F],
    [[F]],
    ['subscriber', [F]],
    ['plugin', 'view', S],
    [{ path: F }],
    // A request object naming its session (the digests, PRDCT-4327): the
    // server must be handed the bare id of the key inside it.
    [{ sessionId: S, key: 'k', launch: {}, messages: [], notes: [], tools: 0 }],
    ['/srv/a', { link: { kind: 'group-terminal', groupId: G, terminalId: 't' } }],
    [S, null],
    [{ path: resourceKey('file', 'x', ATTACHMENT) }]
  ]
  /** Routed members that make no call of their own: they read or release
   *  what the routed members got from the server. Pinned below. */
  const NO_CALL_OF_THEIR_OWN = new Map([
    ['sessionsList', 'merges the snapshots the fleet read from each server'],
    ['sessionsUnsubscribe', 'releases the stream sessionsSubscribe holds on the server']
  ])
  /** Routed members whose server call carries no id of their arguments:
   *  what they send is the window's own state. Pinned below. */
  const NOT_BY_ARGUMENT = new Map([
    ['listTrustedRoots', 'asks every connected server for its trusted roots'],
    ['unwatchDir', 'sends the server the empty tree watch'],
    ['gitUnwatchRepos', 'sends the server the namespace’s whole remaining watch map']
  ])
  /** The bare id a server must be handed for each key a shape carries. */
  const BARE = new Map<string, string>([
    [S, 's1'],
    [F, '/srv/a'],
    [G, 'g1']
  ])
  const keysIn = (value: unknown, depth = 0, out: string[] = []): string[] => {
    if (typeof value === 'string') out.push(value)
    else if (depth < 5 && value && typeof value === 'object')
      for (const v of Object.values(value)) keysIn(v, depth + 1, out)
    return out
  }
  /** What the shape that reached the server got wrong about identities: a
   *  key sent as it is (an owner's key is the window's, never the server's),
   *  or a key whose bare id is not what the server was handed. */
  const identityFaults = (args: unknown[], calls: typeof reached): string[] => {
    const sent = calls.flatMap((c) => keysIn(c.args))
    const faults: string[] = []
    if (sent.some((v) => v.startsWith('clave-owner:'))) faults.push('sent a key, not its bare id')
    for (const k of keysIn(args)) {
      if (!k.startsWith('clave-owner:')) continue
      const bare = BARE.get(k) ?? (k.endsWith(encodeURIComponent(ATTACHMENT)) ? ATTACHMENT : null)
      if (bare && !sent.some((v) => v === bare || v.startsWith(`${bare}/`)))
        faults.push(`was not handed ${bare} for ${k}`)
    }
    return faults
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
  let faults: string[] = []
  const reaches = async (fn: (...a: unknown[]) => unknown): Promise<boolean> => {
    faults = []
    for (const args of shapes) {
      reached.length = 0
      try {
        const answer = fn(...args)
        if (answer instanceof Promise) await Promise.race([answer.catch(() => {}), settle()])
      } catch {
        // a shape this member does not take
      }
      for (let i = 0; i < 6 && reached.length === 0; i++) await settle()
      if (reached.length > 0) {
        await settle()
        faults = identityFaults(args, reached)
        return true
      }
    }
    return false
  }

  it('every routed member reaches the server, and no refused one does', async () => {
    // What a member imports on its first call is loaded now, so no call
    // lands after its member's turn and is counted for the next one.
    await import('@clave/contract/files')
    await (wrapped.fleetList as () => Promise<unknown>)()
    await settle()
    const wrong: string[] = []
    for (const m of members()) {
      const declared = API_PLACEMENT[m.name]
      if (!declared || !m.inLocal || m.name.split('.').pop()!.startsWith('on')) continue
      if (declared.placement === 'local' || NO_CALL_OF_THEIR_OWN.has(m.name)) continue
      const [head, sub] = m.name.split('.')
      const fn = (sub ? (wrapped[head] as Record<string, unknown>)[sub] : wrapped[head]) as (
        ...a: unknown[]
      ) => unknown
      const hit = await reaches(fn)
      // Drain what the member left in flight before the next one is judged.
      for (let i = 0; i < 3; i++) await settle()
      reached.length = 0
      if (declared.placement === 'routed' && !hit)
        wrong.push(`${m.name}: routed, never reaches the server`)
      if (declared.placement === 'refused-for-remote' && hit)
        wrong.push(`${m.name}: refused, yet reaches the server`)
      if (declared.placement === 'routed' && hit && !NOT_BY_ARGUMENT.has(m.name))
        for (const fault of faults) wrong.push(`${m.name}: ${fault}`)
    }
    expect(wrong).toEqual([])
  }, 90_000)

  it('the members exempted from those checks are exactly these, each for its reason', () => {
    expect([...NO_CALL_OF_THEIR_OWN]).toEqual([
      ['sessionsList', 'merges the snapshots the fleet read from each server'],
      ['sessionsUnsubscribe', 'releases the stream sessionsSubscribe holds on the server']
    ])
    expect([...NOT_BY_ARGUMENT]).toEqual([
      ['listTrustedRoots', 'asks every connected server for its trusted roots'],
      ['unwatchDir', 'sends the server the empty tree watch'],
      ['gitUnwatchRepos', 'sends the server the namespace’s whole remaining watch map']
    ])
  })
})
