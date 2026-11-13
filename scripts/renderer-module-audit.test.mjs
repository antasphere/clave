/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  digest,
  validateRendererAudit,
  rendererOutputInventory,
  rendererModuleMetadata
} from './renderer-module-audit.mjs'

describe('actual chunk module audit', () => {
  const fixture = () => {
    const ids = [
      'src/renderer/src/main.tsx',
      'src/renderer/src/views/native-views.ts',
      'plugins/chat-view/src/ChatView.tsx',
      'plugins/chat-view/src/TerminalView.tsx',
      'node_modules/react-markdown/lib/index.js',
      'node_modules/remark-gfm/lib/index.js',
      'node_modules/remark-parse/lib/index.js'
    ]
    return {
      schema: 2,
      owner: 'electron.vite.config.ts:renderer',
      nativeRegistry: ids[1],
      chunks: [
        {
          file: 'assets/native.js',
          sha256: digest('actual output'),
          modules: ids.map((id) => ({ id, renderedLength: 1 }))
        }
      ],
      sources: Object.fromEntries(ids.map((id) => [id, digest(id)])),
      inputs: Object.fromEntries(
        ['package-lock.json', 'electron.vite.config.ts', 'scripts/renderer-module-audit.mjs'].map(
          (id) => [id, digest(id)]
        )
      )
    }
  }
  const check = (audit, source = (id) => id, output = () => 'actual output') =>
    validateRendererAudit(audit, source, output, ['assets/native.js'])
  it('accepts complete bound modules', () => expect(check(fixture()).verdict).toBe('PASS'))
  it('rejects missing, stale, empty or escaped witnesses', () => {
    expect(() => check(undefined)).toThrow()
    expect(() => check(fixture(), () => 'stale')).toThrow('stale source')
    expect(() => check(fixture(), undefined, () => 'stale')).toThrow('stale built output')
    for (const mutate of [
      (a) => {
        a.chunks = []
      },
      (a) => {
        a.chunks[0].modules = []
      },
      (a) => {
        a.chunks[0].modules[2].renderedLength = 0
      },
      (a) => {
        a.chunks[0].file = '../escape'
      },
      (a) => {
        delete a.inputs['package-lock.json']
      }
    ]) {
      const a = fixture()
      mutate(a)
      expect(() => check(a)).toThrow()
    }
  })
  it('rejects actual wrapper or archived cache contributions', () => {
    for (const id of [
      'plugins/chat-view/src/MarkdownMessage.tsx',
      'tests/diagnostics/prefix-cache/plugins/chat-view/src/markdown-parser-reuse.ts'
    ]) {
      const a = fixture()
      a.chunks[0].modules.push({ id, renderedLength: 100 })
      expect(() => check(a)).toThrow('prefix-cache')
    }
  })
  it('rejects a partially omitted two-output inventory even when all positives remain', () => {
    const audit = fixture()
    const actual = ['assets/native.js', 'assets/cache.js']
    audit.chunks.push({
      file: 'assets/cache.js',
      sha256: digest('cache output'),
      modules: [{ id: 'plugins/chat-view/src/MarkdownMessage.tsx', renderedLength: 10 }]
    })
    const output = (id) => (id === 'assets/cache.js' ? 'cache output' : 'actual output')
    expect(() => validateRendererAudit(audit, (id) => id, output, actual)).toThrow('prefix-cache')
    audit.chunks.pop()
    expect(() => validateRendererAudit(audit, (id) => id, output, actual)).toThrow('inventory')
  })
  it('rejects extra, duplicate or absent actual inventory records', () => {
    const audit = fixture()
    expect(() =>
      validateRendererAudit(
        audit,
        (id) => id,
        () => 'actual output',
        []
      )
    ).toThrow()
    expect(() =>
      validateRendererAudit(
        audit,
        (id) => id,
        () => 'actual output'
      )
    ).toThrow()
    expect(() =>
      validateRendererAudit(
        audit,
        (id) => id,
        () => 'actual output',
        ['assets/native.js', 'assets/native.js']
      )
    ).toThrow('unique')
    audit.chunks.push(structuredClone(audit.chunks[0]))
    expect(() => check(audit)).toThrow('unique')
    audit.chunks[1].file = 'assets/extra.js'
    expect(() => check(audit)).toThrow('inventory')
  })
  it('requires source identities for every physical module, including wrapped CommonJS', () => {
    for (const id of ['src/renderer/src/other.ts', '\0node_modules/other/index.js']) {
      const audit = fixture()
      audit.chunks[0].modules.push({ id, renderedLength: 1 })
      expect(() => check(audit)).toThrow('physical module source identity')
    }
  })
  it('binds real two-file output inventory and physical CommonJS source through the metadata hook', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'renderer-audit-pure-'))
    try {
      const audit = fixture(),
        out = path.join(root, 'out/renderer')
      const write = (file, data) => {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, data)
      }
      for (const id of [...Object.keys(audit.sources), ...Object.keys(audit.inputs)])
        write(path.join(root, id), id)
      const extra = 'node_modules/extra/index.js'
      write(path.join(root, extra), 'physical commonjs')
      write(path.join(out, 'assets/native.js'), 'actual output')
      write(path.join(out, 'assets/other.js'), 'second output')
      rendererModuleMetadata(root).writeBundle(
        { dir: 'out/renderer' },
        {
          first: {
            type: 'chunk',
            fileName: 'assets/native.js',
            modules: Object.fromEntries(
              Object.keys(audit.sources).map((id) => [path.join(root, id), { renderedLength: 1 }])
            )
          },
          second: {
            type: 'chunk',
            fileName: 'assets/other.js',
            modules: {
              ['\0' + path.join(root, extra) + '?commonjs-proxy']: { renderedLength: 10 },
              '\0commonjsHelpers.js': { renderedLength: 10 }
            }
          }
        }
      )
      const emitted = JSON.parse(readFileSync(path.join(out, 'renderer-module-audit.json'), 'utf8'))
      const checkActual = () =>
        validateRendererAudit(
          emitted,
          (id) => readFileSync(path.join(root, id)),
          (id) => readFileSync(path.join(out, id)),
          rendererOutputInventory(out)
        )
      expect(checkActual().chunks).toHaveLength(2)
      expect(emitted.sources[extra]).toBe(digest('physical commonjs'))
      expect(rendererOutputInventory(out)).toEqual(['assets/native.js', 'assets/other.js'])
      emitted.chunks.pop()
      expect(checkActual).toThrow('inventory')
      emitted.chunks = audit.chunks
      write(path.join(out, 'assets/unrecorded.mjs'), 'unrecorded output')
      expect(checkActual).toThrow('inventory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
