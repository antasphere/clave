import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  installTerminalPorts,
  resetTerminalPorts,
  resourcesDirOfEntry,
  unpackedPath
} from '../../ports/terminals'
import { tempDataDir } from '../../ports/testing'
import { piStateExtensionPath } from './pty-backend'

/**
 * Where a Pi tab's Clave extension is read from (PRDCT-4496). The path was
 * once joined to the backend module's own `__dirname`, which names
 * `src/main/sessions/adapters` from source and a bundle chunk's folder when
 * built: every Pi tab ended on "Extension path does not exist". The entry
 * names the resources folder now, from its own folder, and these trees are
 * the three layouts an entry runs in, each with the code that builds the
 * command line sitting somewhere else (a deeper folder, a chunk).
 */

const EXTENSION = 'pi-clave-state.js'
const dirs: string[] = []

function tree(files: string[]): string {
  const root = fs.realpathSync(tempDataDir('clave-pi-extension-'))
  dirs.push(root)
  for (const file of files) {
    const full = path.join(root, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, '')
  }
  return root
}

afterEach(() => {
  resetTerminalPorts()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** What a Pi tab's command line carries, with the resources folder the entry
 *  at `entryDir` names. */
function extensionFromEntry(entryDir: string): string {
  installTerminalPorts({ resourcesDir: resourcesDirOfEntry(entryDir) })
  return piStateExtensionPath()
}

describe("a Pi tab's Clave extension, named by the entry (PRDCT-4496)", () => {
  it('from source: the server entry in src/main, the backend in src/main/sessions/adapters', () => {
    const root = tree([
      'src/main/server-entry.ts',
      'src/main/sessions/adapters/pty-backend.ts',
      `resources/${EXTENSION}`
    ])
    const extension = extensionFromEntry(path.join(root, 'src/main'))
    expect(extension).toBe(path.join(root, 'resources', EXTENSION))
    expect(fs.existsSync(extension)).toBe(true)
  })

  it('from the bundle: the entry in out/main, the backend in a chunk under out/main/chunks', () => {
    const root = tree([
      'out/main/server-entry.js',
      'out/main/index.js',
      'out/main/chunks/provider-injection-wiring-abc123.js',
      `resources/${EXTENSION}`
    ])
    const extension = extensionFromEntry(path.join(root, 'out/main'))
    expect(extension).toBe(path.join(root, 'resources', EXTENSION))
    expect(fs.existsSync(extension)).toBe(true)
  })

  it('packaged: the entry in app.asar/out/main, the file unpacked beside the asar', () => {
    // The asar is a file in a real app; here a folder stands for it. What
    // matters is that Pi is given the unpacked copy, the one it can read.
    const resources = tree([
      'Clave.app/Contents/Resources/app.asar/out/main/server-entry.js',
      'Clave.app/Contents/Resources/app.asar/out/main/chunks/service-abc123.js',
      `Clave.app/Contents/Resources/app.asar.unpacked/resources/${EXTENSION}`
    ])
    const contents = path.join(resources, 'Clave.app/Contents/Resources')
    const extension = extensionFromEntry(path.join(contents, 'app.asar/out/main'))
    expect(extension).toBe(path.join(contents, 'app.asar.unpacked', 'resources', EXTENSION))
    expect(fs.existsSync(extension)).toBe(true)
  })

  it("packaged, from the Electron shell's own folder (process.resourcesPath/app.asar/resources)", () => {
    const resources = tree([`app.asar.unpacked/resources/${EXTENSION}`])
    installTerminalPorts({ resourcesDir: path.join(resources, 'app.asar', 'resources') })
    const extension = piStateExtensionPath()
    expect(extension).toBe(path.join(resources, 'app.asar.unpacked', 'resources', EXTENSION))
    expect(fs.existsSync(extension)).toBe(true)
  })

  it('refuses to name a path before an entry named the folder, with the fix named', () => {
    expect(() => piStateExtensionPath()).toThrow(/installTerminalPorts\(\{ resourcesDir \}\)/)
  })
})

describe('the unpacked path of a file under the asar', () => {
  it('maps app.asar once and leaves an unpacked or unpackaged path alone', () => {
    expect(unpackedPath('/A/Resources/app.asar/resources/x.js')).toBe(
      '/A/Resources/app.asar.unpacked/resources/x.js'
    )
    expect(unpackedPath('/A/Resources/app.asar.unpacked/resources/x.js')).toBe(
      '/A/Resources/app.asar.unpacked/resources/x.js'
    )
    expect(unpackedPath('/repo/resources/x.js')).toBe('/repo/resources/x.js')
  })
})
