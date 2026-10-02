import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The client and the server load on first use, never at window start or at
 * boot: a static import of either costs every window about half a second of
 * synchronous requires (measured at 0.4 to 0.75 s) and failed two end-to-end
 * specs. Nothing else goes red when that import comes back, so this holds it
 * at the source: the preload may import the router and the env names only,
 * and the shell may name the server package in a dynamic import only.
 */
const root = join(__dirname, '..', '..', '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')
/** Runtime imports only: an `import type` is erased and costs nothing. */
const staticImports = (source: string): string[] =>
  [...source.matchAll(/^import\s(?!type\s)[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('the client and the server load lazily', () => {
  it('the preload imports nothing of the client at window start', () => {
    const imports = staticImports(read('src/preload/index.ts'))
    const heavy = imports.filter(
      (spec) =>
        /^@clave\/(client|server)$/.test(spec) ||
        /^@clave\/client\/(?!router$)/.test(spec) ||
        /^@clave\/contract(?!\/env$)/.test(spec) ||
        /^(effect|@effect\/|@structure-ai\/)/.test(spec)
    )
    expect(heavy).toEqual([])
    expect(read('src/preload/index.ts')).toMatch(/await import\('@clave\/client'\)/)
  })
  it('main names the server package only in a dynamic import', () => {
    const source = read('src/main/server/clave-server.ts')
    const imports = staticImports(source).filter((spec) => spec === '@clave/server')
    expect(imports).toEqual([])
    expect(source).toMatch(/await import\('@clave\/server'\)/)
    const handlers = staticImports(read('src/main/ipc-handlers/server-handlers.ts'))
    expect(handlers.some((spec) => spec.endsWith('clave-server'))).toBe(false)
  })
})
