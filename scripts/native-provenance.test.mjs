/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node verification fixtures */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import codec from 'jsc-safe-url'
import { afterEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ fixture: null, sockets: [], git: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: boundary.git }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    WebSocket: class extends EventEmitter {
      constructor() {
        super()
        this.closed = false
        boundary.sockets.push(this)
        queueMicrotask(() => this.emit('open'))
      }
      send(raw) {
        const request = JSON.parse(raw)
        queueMicrotask(() => {
          if (request.method === 'Debugger.enable') {
            for (const script of boundary.fixture.scripts)
              this.emit(
                'message',
                JSON.stringify({ method: 'Debugger.scriptParsed', params: script })
              )
            this.emit('message', JSON.stringify({ id: request.id, result: {} }))
          } else {
            assert.equal(request.method, 'Debugger.getScriptSource')
            this.emit(
              'message',
              JSON.stringify({
                id: request.id,
                result: { scriptSource: boundary.fixture.loaded }
              })
            )
          }
        })
      }
      close() {
        this.closed = true
        this.emit('close')
      }
      terminate() {
        this.close()
      }
    }
  }
})
import { proveNativeSource } from '../packages/mobile/scripts/native-provenance.mjs'

const pkg = fileURLToPath(new URL('../packages/mobile', import.meta.url))
const files = [
  'src/App.tsx',
  'src/screens/MachinesScreen.tsx',
  'src/navigation/RootNavigator.tsx',
  'src/platform/account.ts'
]
const candidate = 'synthetic-committed-candidate'
const marker = 'SYNTHETIC_PRIVATE_QUERY'
function setup(entry = '/packages/mobile/index') {
  const loaded = `const root = ${JSON.stringify(pkg)};`
  const fixture = {
    scripts: [
      {
        scriptId: 'owned',
        url: `http://127.0.0.1:8082${entry}.bundle?dev=true&marker=${marker}`,
        sourceMapURL: `http://127.0.0.1:8082${entry}.map?dev=true&marker=${marker}`
      }
    ],
    loaded,
    served: loaded,
    map: {
      version: 3,
      sources: files.map((file) => `${pkg}/${file}`),
      sourcesContent: files.map((file) => readFileSync(`${pkg}/${file}`, 'utf8'))
    },
    targets: [
      {
        appId: 'com.clave.app.mobile',
        deviceName: 'Owned iPhone',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8082/inspector/debug?device=owned'
      }
    ],
    requests: []
  }
  boundary.fixture = fixture
  boundary.git.mockImplementation((command, args, options) => {
    assert.equal(command, 'git')
    assert.equal(options.cwd, pkg)
    if (args[0] === 'rev-parse') return `${candidate}\n`
    assert.deepEqual(args, ['diff', 'HEAD', '--exit-code', '--quiet'])
    return Buffer.alloc(0)
  })
  vi.stubGlobal('fetch', async (value) => {
    const url = new URL(value)
    assert.equal(url.origin, 'http://127.0.0.1:8082')
    fixture.requests.push(url)
    if (url.pathname === '/json/list') return { json: async () => fixture.targets }
    assert.equal(url.searchParams.get('dev'), 'true')
    assert.equal(url.searchParams.get('marker'), marker)
    assert.ok(!url.pathname.includes('//&'))
    if (url.pathname.endsWith('.bundle')) {
      assert.equal(url.searchParams.get('transform.bytecode'), '0')
      return { text: async () => fixture.served }
    }
    assert.equal(url.searchParams.get('excludeSource'), 'false')
    assert.ok(url.pathname.endsWith('.map'))
    return { json: async () => fixture.map }
  })
  return fixture
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const socket of boundary.sockets.splice(0)) expect(socket.closed).toBe(true)
  boundary.git.mockReset()
})
async function proof(fixture, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'clave-native-source-'))
  const output = path.join(directory, 'proof.json')
  try {
    const result = await proveNativeSource({
      port: 8082,
      deviceName: 'Owned iPhone',
      output,
      ...options
    })
    expect(result.candidate).toBe(candidate)
    expect(result.worktree).toBe(pkg)
    expect(result.checked).toEqual(files)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(result)
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(fixture.requests).toHaveLength(3)
    expect(boundary.git.mock.calls.map((call) => call[1])).toEqual([
      ['diff', 'HEAD', '--exit-code', '--quiet'],
      ['rev-parse', 'HEAD'],
      ['diff', 'HEAD', '--exit-code', '--quiet']
    ])
    return result
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
for (const entry of ['/packages/mobile/index', '/.expo/.virtual-metro-entry']) {
  for (const representation of ['normal', 'bundle', 'map', 'both']) {
    it(`actual helper persists exact ${entry} proof with ${representation} metadata`, async () => {
      const fixture = setup(entry)
      if (['bundle', 'both'].includes(representation))
        fixture.scripts[0].url = codec.toJscSafeUrl(fixture.scripts[0].url)
      if (['map', 'both'].includes(representation))
        fixture.scripts[0].sourceMapURL = codec.toJscSafeUrl(fixture.scripts[0].sourceMapURL)
      await proof(fixture)
    })
  }
}
const negatives = [
  [
    'missing entry',
    (f) => {
      f.scripts = []
    },
    /entry bundle/
  ],
  [
    'ambiguous entries',
    (f) => {
      f.scripts.push({ ...f.scripts[0], scriptId: 'second' })
    },
    /entry bundle/
  ],
  [
    'substring entry',
    (f) => {
      f.scripts[0].url = f.scripts[0].url.replace('.bundle', '.bundle.foreign')
    },
    /entry bundle/
  ],
  [
    'malformed entry',
    (f) => {
      f.scripts[0].url = 'not a URL'
    },
    /entry bundle/
  ],
  [
    'foreign loaded host',
    (f) => {
      f.scripts[0].url = f.scripts[0].url.replace('127.0.0.1', 'foreign.invalid')
    },
    /explicit device host/
  ],
  [
    'foreign loaded port',
    (f) => {
      f.scripts[0].url = f.scripts[0].url.replace(':8082', ':8083')
    },
    /owned Metro port/
  ],
  [
    'wrong worktree',
    (f) => {
      f.loaded = 'foreign worktree'
    },
    /exact worktree/
  ],
  [
    'loaded hash mismatch',
    (f) => {
      f.served += 'different'
    },
    /differs from the current Metro bundle/
  ],
  [
    'disk mismatch',
    (f) => {
      f.map.sourcesContent[0] = 'different'
    },
    /differs from disk/
  ],
  [
    'App missing',
    (f) => {
      f.map.sources.shift()
      f.map.sourcesContent.shift()
    },
    /include this App.tsx/
  ],
  [
    'foreign target device',
    (f) => {
      f.targets[0].deviceName = 'Other iPhone'
    },
    /Exactly one owned native app/
  ],
  [
    'ambiguous app targets',
    (f) => {
      f.targets.push({ ...f.targets[0] })
    },
    /Exactly one owned native app/
  ]
]
for (const [name, change, message] of negatives) {
  it(`actual helper rejects ${name}`, async () => {
    const fixture = setup()
    change(fixture)
    for (const script of fixture.scripts) script.url = codec.toJscSafeUrl(script.url)
    await expect(proveNativeSource({ port: 8082, deviceName: 'Owned iPhone' })).rejects.toThrow(
      message
    )
  })
}

// Execute the unchanged acceptance driver's actual import and source-proof call.
const consumer = readFileSync(new URL('./mobile-beta-native.mjs', import.meta.url), 'utf8')
const importStart = consumer.indexOf('    const { proveNativeSource } = await load(')
const importEnd = consumer.indexOf('\n', importStart)
const callStart = consumer.indexOf("    phase = 'native-source'\n")
const callEnd = consumer.indexOf("    phase = 'sanitized-screenshot'", callStart)
assert.ok(
  importStart > 0 && importEnd > importStart && callStart > importEnd && callEnd > callStart
)
const AsyncFunction = Object.getPrototypeOf(async function () {
  return undefined
}).constructor
const callConsumer = new AsyncFunction(
  'load',
  'receipt',
  'o',
  'deviceName',
  'assert',
  'realpathSync',
  'path',
  'cleanHead',
  'let phase;\n' +
    consumer.slice(importStart, importEnd) +
    '\n' +
    consumer.slice(callStart, callEnd)
)
for (const variant of ['matching', 'wrong candidate', 'wrong worktree']) {
  it(`actual acceptance import/caller ${variant} preserves identity checks`, async () => {
    const fixture = setup('/.expo/.virtual-metro-entry')
    fixture.scripts[0].url = codec.toJscSafeUrl(fixture.scripts[0].url)
    fixture.scripts[0].sourceMapURL = codec.toJscSafeUrl(fixture.scripts[0].sourceMapURL)
    const receipt = { source: 'NOT RUN' }
    const options = { 'metro-port': '8082', candidate, worktree: path.dirname(path.dirname(pkg)) }
    if (variant === 'wrong candidate') options.candidate = 'foreign-candidate'
    if (variant === 'wrong worktree') options.worktree += '/foreign-worktree'
    const cleanHead = vi.fn()
    const pending = callConsumer(
      async (file) => {
        assert.equal(file, 'packages/mobile/scripts/native-provenance.mjs')
        return { proveNativeSource }
      },
      receipt,
      options,
      'Owned iPhone',
      assert,
      realpathSync,
      path,
      cleanHead
    )
    if (variant !== 'matching') {
      await expect(pending).rejects.toThrow(
        variant === 'wrong candidate' ? 'foreign-candidate' : 'foreign-worktree'
      )
      expect(receipt.source).toMatchObject({ candidate, worktree: pkg })
      expect(fixture.requests).toHaveLength(3)
      expect(cleanHead).not.toHaveBeenCalled()
      return
    }
    await pending
    expect(cleanHead).toHaveBeenCalledExactlyOnceWith(options)
    expect(receipt.source.candidate).toBe(candidate)
    expect(receipt.source.worktree).toBe(pkg)
    expect(receipt.source.checked).toEqual(files)
    expect(JSON.stringify(receipt)).not.toContain(marker)
  })
}
