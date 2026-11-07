import { expect, it } from 'vitest'
import { pluginManifestSchema } from '@clave/plugin-sdk'

const skin = {
  id: 'clave.dark',
  name: 'Dark',
  version: '1.0.0',
  kind: 'skin',
  engines: { clave: '*' },
  skin: { tokens: 'skin.json', base: 'dark' }
}
it('accepts the skin lane descriptor without executable UI', () => {
  expect(pluginManifestSchema.parse(skin).ui).toBe('none')
})
it('rejects execution, privileges and unknown fields in skin packages', () => {
  for (const extra of [
    { main: 'main.js' },
    { ui: 'surface' },
    { permissions: ['shell'] },
    { skin: { ...skin.skin, unknown: true } },
    { contributes: { commands: [{ id: 'run', title: 'Run' }] } }
  ]) {
    expect(pluginManifestSchema.safeParse({ ...skin, ...extra }).success).toBe(false)
  }
})
