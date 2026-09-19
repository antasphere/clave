import dark from './skins/dark/skin.json'
import light from './skins/light/skin.json'
import coffee from './skins/coffee/skin.json'
import charcoal from './skins/charcoal/skin.json'
import type { Skin } from './types'
export const bundledSkins: Skin[] = Object.entries({ dark, charcoal, light, coffee }).map(
  ([id, tokens]) => ({
    kind: 'skin',
    id,
    name: id[0].toUpperCase() + id.slice(1),
    version: '1.0.0',
    engines: { clave: '>=1.90.2' },
    skin: { tokens: 'skin.json', base: id === 'light' || id === 'coffee' ? 'light' : 'dark' },
    tokens,
    bundled: true
  })
)
