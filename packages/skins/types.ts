export interface SkinManifest {
  kind: 'skin'
  id: string
  name: string
  version: string
  engines: { clave: string }
  skin: { tokens: string; css?: string; base: 'dark' | 'light' }
}
export interface Skin extends SkinManifest {
  tokens: Record<string, string>
  bundled: boolean
}
export interface SkinState {
  skins: Skin[]
  activeId: string | null
  errors: string[]
}
