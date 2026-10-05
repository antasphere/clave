import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * The client and the server load on first use, never at window start or at
 * boot: a static import of either costs every window about half a second of
 * synchronous requires (measured at 0.4 to 0.75 s) and failed two end-to-end
 * specs. Nothing else goes red when that import comes back, so this holds it
 * twice: at the artefact, by bundling each entry the way the app does and
 * refusing any Effect or framework module in the entry's own output (a
 * dynamic import lands in another chunk, a static one, direct or through a
 * subpath or a local re-export, lands here); and at the source, as the
 * plainer message when the artefact check goes red.
 */
const root = join(__dirname, '..', '..', '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')
/** Runtime imports only: an `import type` is erased and costs nothing. */
const staticImports = (source: string): string[] =>
  [...source.matchAll(/^import\s(?!type\s)[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

/** What must never be reached at window start or at boot: Effect itself,
 *  its platform packages, the framework, and OpenTelemetry under it. The
 *  guard is only as wide as this pattern; a package the framework adds
 *  under a new scope belongs here too. */
const HEAVY = /node_modules\/(effect|@effect|@structure-ai|@opentelemetry)\//

/** The modules an entry pulls in statically: esbuild's metafile for the entry's
 *  own output and every chunk it imports with an import statement, followed
 *  through (a module shared with a dynamic chunk is hoisted into a chunk of
 *  its own, still imported statically); what only a dynamic import reaches
 *  stays out. */
const staticallyReached = async (entry: string): Promise<string[]> => {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    write: false,
    metafile: true,
    logLevel: 'silent',
    outdir: join(tmpdir(), 'clave-lazy-load-guard'),
    external: ['electron']
  })
  const outputs = result.metafile.outputs
  const entryName = Object.keys(outputs).find((name) => {
    const point = outputs[name].entryPoint
    return point !== undefined && point.endsWith(entry.replace(/\\/g, '/'))
  })
  if (!entryName) throw new Error(`No entry output for ${entry}`)
  const reached = new Set<string>()
  const seen = new Set<string>()
  const follow = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const output = outputs[name]
    for (const input of Object.keys(output.inputs)) reached.add(input)
    for (const imported of output.imports)
      if (imported.kind === 'import-statement' && outputs[imported.path]) follow(imported.path)
  }
  follow(entryName)
  return [...reached]
}

describe('the client and the server load lazily', () => {
  it('the built preload reaches no Effect module at window start', async () => {
    const reached = await staticallyReached('src/preload/index.ts')
    expect(reached.filter((file) => HEAVY.test(file))).toEqual([])
    expect(
      reached.filter((file) => /client\/src\/router\.ts$/.test(file)),
      reached.join('\n')
    ).toHaveLength(1)
  }, 30_000)
  it('the shell seam reaches no Effect module when main loads it', async () => {
    const reached = await staticallyReached('src/main/server/clave-server.ts')
    expect(reached.filter((file) => HEAVY.test(file))).toEqual([])
    expect(
      reached.filter((file) => /server\/src\/embedded\.ts$/.test(file)),
      reached.join('\n')
    ).toHaveLength(0)
  }, 30_000)
  it('the preload imports nothing of the client at window start (the source says so too)', () => {
    const imports = staticImports(read('src/preload/index.ts'))
    const heavy = imports.filter(
      (spec) =>
        /^@clave\/(client|server)(\/(?!router$)|$)/.test(spec) ||
        /^@clave\/contract(?!\/env$)/.test(spec) ||
        /^(effect|@effect\/|@structure-ai\/|ws$)/.test(spec)
    )
    expect(heavy).toEqual([])
    const source = read('src/preload/index.ts')
    // The client through Node (`@clave/client/node`, ADR 0003): the request
    // client over @effect/platform-node and the push socket over ws, so the
    // packaged page sends no Origin and meets no CSP.
    expect(source).toMatch(/await import\('@clave\/client\/node'\)/)
    // One runtime dynamic import, the awaited one inside connect: an eager
    // top-level `void import(...)` would pass the artefact walk and still
    // cost the window start (measured at about 400 ms). A type position's
    // `import('x').Name` is erased and does not count. The Node packages the
    // transport needs are imported inside that module, not here.
    const dynamic = [...source.matchAll(/\bimport\(['"]([^'"]+)['"]\)(?!\.)/g)].map((m) => m[1])
    expect(dynamic).toEqual(['@clave/client/node'])
  })
  it('main names the server package only in a dynamic import (the source says so too)', () => {
    const source = read('src/main/server/clave-server.ts')
    const imports = staticImports(source).filter((spec) => /^@clave\/server(\/|$)/.test(spec))
    expect(imports).toEqual([])
    expect(source).toMatch(/await import\('@clave\/server'\)/)
    const handlers = staticImports(read('src/main/ipc-handlers/server-handlers.ts'))
    expect(handlers.some((spec) => spec.endsWith('clave-server'))).toBe(false)
  })
})
