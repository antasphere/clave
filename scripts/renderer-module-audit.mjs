/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JavaScript verification tooling */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const digest = (value) => createHash('sha256').update(value).digest('hex')
const forbidden =
  /(?:MarkdownMessage\.tsx|markdown-parser-reuse(?:\.ts)?|diagnostics\/prefix-cache)/
const required = [
  'src/renderer/src/main.tsx',
  'src/renderer/src/views/native-views.ts',
  'plugins/chat-view/src/ChatView.tsx',
  'plugins/chat-view/src/TerminalView.tsx',
  'node_modules/react-markdown/lib/index.js',
  'node_modules/remark-gfm/lib/index.js',
  'node_modules/remark-parse/lib/index.js'
]

// Both native views are compiled by this same Vite renderer build, through
// native-views.ts. This hook observes actual Rollup chunk.modules metadata.
// It emits a sidecar asset and changes no runtime source or compiler option.
export function rendererModuleMetadata(root = process.cwd()) {
  return {
    name: 'renderer-module-metadata',
    writeBundle(options, bundle) {
      const sources = {}
      const chunks = Object.values(bundle)
        .filter((item) => item.type === 'chunk')
        .map((chunk) => ({
          file: chunk.fileName,
          sha256: digest(readFileSync(path.resolve(root, options.dir, chunk.fileName))),
          modules: Object.entries(chunk.modules).map(([id, contribution]) => {
            const clean = id.split('?')[0]
            const name = path.relative(root, clean).split(path.sep).join('/')
            if (path.isAbsolute(clean) && existsSync(clean))
              sources[name] = digest(readFileSync(clean))
            return { id: name, renderedLength: contribution.renderedLength }
          })
        }))
      const inputs = Object.fromEntries(
        ['package-lock.json', 'electron.vite.config.ts', 'scripts/renderer-module-audit.mjs'].map(
          (p) => [p, digest(readFileSync(path.join(root, p)))]
        )
      )
      writeFileSync(
        path.resolve(root, options.dir, 'renderer-module-audit.json'),
        JSON.stringify(
          {
            schema: 1,
            owner: 'electron.vite.config.ts:renderer',
            nativeRegistry: 'src/renderer/src/views/native-views.ts',
            chunks,
            sources,
            inputs
          },
          null,
          2
        ) + '\n'
      )
    }
  }
}

export function validateRendererAudit(audit, readSource, readOutput) {
  assert.equal(audit?.schema, 1, 'missing/stale module audit schema')
  assert.equal(audit.owner, 'electron.vite.config.ts:renderer')
  assert.equal(audit.nativeRegistry, 'src/renderer/src/views/native-views.ts')
  assert.ok(audit.chunks?.length > 0, 'nonempty actual chunks required')
  const modules = audit.chunks.flatMap((chunk) => {
    assert.ok(
      chunk.file && !path.isAbsolute(chunk.file) && !chunk.file.split('/').includes('..'),
      'contained chunk'
    )
    assert.equal(digest(readOutput(chunk.file)), chunk.sha256, 'stale built output: ' + chunk.file)
    assert.ok(chunk.modules?.length > 0, 'nonempty chunk module witness')
    return chunk.modules
  })
  assert.ok(
    modules.every(({ id }) => !forbidden.test(id)),
    'custom prefix-cache module in actual native build'
  )
  for (const id of required) {
    assert.ok(
      modules.some((entry) => entry.id === id && entry.renderedLength > 0),
      'missing positive native/public module: ' + id
    )
    assert.ok(audit.sources[id], 'missing positive module source identity: ' + id)
  }
  for (const id of [
    'package-lock.json',
    'electron.vite.config.ts',
    'scripts/renderer-module-audit.mjs'
  ])
    assert.ok(audit.inputs?.[id], 'missing build identity: ' + id)
  for (const [id, hash] of Object.entries({ ...audit.sources, ...audit.inputs })) {
    assert.ok(!path.isAbsolute(id) && !id.split('/').includes('..'), 'contained source identity')
    assert.equal(digest(readSource(id)), hash, 'stale source/lock: ' + id)
  }
  return {
    verdict: 'PASS',
    chunks: audit.chunks.map(({ file, sha256 }) => ({ file, sha256 })),
    nativeViews: required.slice(1, 4),
    sourceCount: Object.keys(audit.sources).length,
    inputs: audit.inputs
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd()
  const out = path.join(root, 'out/renderer')
  const audit = JSON.parse(readFileSync(path.join(out, 'renderer-module-audit.json'), 'utf8'))
  console.log(
    JSON.stringify(
      validateRendererAudit(
        audit,
        (id) => readFileSync(path.join(root, id)),
        (id) => readFileSync(path.join(out, id))
      ),
      null,
      2
    )
  )
}
