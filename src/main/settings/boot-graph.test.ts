/**
 * The shell's settings source is loaded by main at boot (`src/main/index.ts`
 * and six IPC handler modules import it statically), so its import graph is
 * the lane's part of the lazy-load rule: nothing of Effect or the framework
 * at boot (`server/lazy-load.test.ts` guards the preload and the server
 * seam; this guards the settings seam, which round 2's verifier found
 * uncovered: a runtime import of `@clave/server` in `source.ts` passed every
 * gate). The walk is the guard's own, with the native image module stubbed
 * (the app icon's graph reaches it).
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..', '..')
const HEAVY = /node_modules\/(effect|@effect|@structure-ai|@opentelemetry)\//

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
    outdir: join(tmpdir(), 'clave-settings-boot-guard'),
    external: ['electron'],
    loader: { '.node': 'empty' }
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

describe('the settings source loads nothing of Effect at boot', () => {
  it('the shell source reaches no Effect or framework module', async () => {
    const reached = await staticallyReached('src/main/settings/shell-source.ts')
    expect(reached.filter((file) => HEAVY.test(file))).toEqual([])
    expect(reached.some((file) => /src\/main\/settings\/source\.ts$/.test(file))).toBe(true)
  })
  it('the standalone source reaches no Electron-bound module either', async () => {
    const reached = await staticallyReached('src/main/settings/standalone-source.ts')
    expect(reached.filter((file) => HEAVY.test(file))).toEqual([])
    expect(
      reached.filter((file) => /account-login\.ts$|app-icon\.ts$|pty-backend/.test(file))
    ).toEqual([])
  })
})
