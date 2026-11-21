import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isEngineCompatible, pluginManifestSchema } from '@clave/plugin-sdk'

/**
 * Every plugin the app ships must accept the app it ships in (#423).
 * The host judges a manifest's `engines.clave` against the app's version
 * (`app.getVersion()`, the package's, or the beta's injected one). Each
 * 3.0.0 beta satisfied `<3.0.0`; the stable 3.0.0 did not, and six bundled
 * plugins, the chat view among them, were refused with "Requires Clave …".
 */
const root = resolve(__dirname, '..', '..', '..')
const version = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
).version
const bundled = readdirSync(join(root, 'plugins'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, 'plugins', entry.name, 'clave-plugin.json'))
  .filter((file) => existsSync(file))

describe('the bundled plugins accept the app they ship in (#423)', () => {
  it('finds the bundled manifests', () => {
    expect(bundled.length).toBeGreaterThanOrEqual(7)
  })
  for (const file of bundled)
    it(`${file.split('/').at(-2)} accepts Clave ${version} and its betas`, () => {
      const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      expect(isEngineCompatible(manifest, version)).toBe(true)
      expect(isEngineCompatible(manifest, `${version}-beta.1`)).toBe(true)
    })
})
