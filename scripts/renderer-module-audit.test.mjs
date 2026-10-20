/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import { describe, it, expect } from 'vitest'
import { digest, validateRendererAudit } from './renderer-module-audit.mjs'

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
      schema: 1,
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
    validateRendererAudit(audit, source, output)
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
})
