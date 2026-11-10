import { describe, expect, it, vi } from 'vitest'
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
      mocks.local = args[0] as unknown as Record<string, unknown>
      return real.createFleetDesktop(...args)
    }
  }
})
await import('./index')

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

  it('the four digest members go to the server a tab runs on (PRDCT-4327)', () => {
    for (const name of ['exchangeDigest', 'exchangeDigestsOf', 'workDigest', 'workDigestsOf'])
      expect(API_PLACEMENT[name]).toEqual({ placement: 'routed' })
  })
})
