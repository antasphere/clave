import { inheritSkinTokens, skinToXterm } from '../../../packages/skins/skin-to-xterm'
import {
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
  writeFileSync,
  renameSync,
  rmSync,
  watch,
  type FSWatcher
} from 'fs'
import { join, basename } from 'path'
import { bundledSkins } from '../../../packages/skins/bundled'
import type { Skin, SkinState } from '../../../packages/skins/types'
import { validateManifest, validateTokens, parseSkinCss } from './validation'

export class SkinStore {
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private poll?: ReturnType<typeof setInterval>
  private fingerprint = ''
  constructor(
    private root: string,
    private version: string,
    private active: () => string | null,
    private persist: (id: string) => void,
    private changed: (state: SkinState) => void
  ) {
    mkdirSync(root, { recursive: true })
  }

  private read(folder: string): Skin {
    const read = (name: string): string => {
      const file = join(folder, name)
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
        throw new Error('Skin files must be regular files')
      if (lstatSync(file).size > 128 * 1024) throw new Error('Skin file exceeds 128 KB')
      return readFileSync(file, 'utf8')
    }
    const manifest = validateManifest(JSON.parse(read('clave-plugin.json')), this.version)
    const tokens = validateTokens(JSON.parse(read('skin.json')))
    if (manifest.skin.css) Object.assign(tokens, parseSkinCss(read(manifest.skin.css)))
    const base = bundledSkins.find((s) => s.id === manifest.skin.base)!
    const resolved = inheritSkinTokens(base.tokens, tokens)
    skinToXterm(resolved)
    return { ...manifest, tokens: resolved, bundled: false }
  }

  list(): SkinState {
    const skins = [...bundledSkins]
    const errors: string[] = []
    for (const entry of existsSync(this.root)
      ? readdirSync(this.root, { withFileTypes: true })
      : []) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const skin = this.read(join(this.root, entry.name))
        if (skin.id !== entry.name || skins.some((s) => s.id === skin.id))
          throw new Error('Duplicate or mismatched skin id')
        skins.push(skin)
      } catch (error) {
        errors.push(`${entry.name}: ${String(error)}`)
      }
    }
    let activeId = this.active()
    if (activeId && !skins.some((s) => s.id === activeId)) {
      activeId = 'dark'
      this.persist(activeId)
    }
    return { skins, activeId, errors }
  }

  activate(id: string): SkinState {
    if (!this.list().skins.some((s) => s.id === id)) throw new Error('Skin not found')
    this.persist(id)
    return this.publish()
  }

  import(source: string): SkinState {
    if (lstatSync(source).isSymbolicLink()) throw new Error('Symlink skins are not supported')
    let skin: Skin
    if (lstatSync(source).isFile()) {
      if (lstatSync(source).size > 128 * 1024) throw new Error('Skin file exceeds 128 KB')
      const tokens = validateTokens(JSON.parse(readFileSync(source, 'utf8')))
      const id = `imported-${basename(source, '.json')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 40)}`
      skin = {
        kind: 'skin',
        id,
        name: basename(source, '.json'),
        version: '1.0.0',
        engines: { clave: '>=1.90.2' },
        skin: { tokens: 'skin.json', base: 'dark' },
        tokens,
        bundled: false
      }
    } else {
      skin = this.read(source)
    }
    validateManifest(skin, this.version)
    skinToXterm(
      inheritSkinTokens(bundledSkins.find((s) => s.id === skin.skin.base)!.tokens, skin.tokens)
    )
    if (this.list().skins.some((s) => s.id === skin.id))
      throw new Error('A skin with this id is already installed')
    const target = join(this.root, skin.id)
    const staging = join(this.root, `.${skin.id}-${Date.now()}`)
    mkdirSync(this.root, { recursive: true })
    mkdirSync(staging)
    try {
      const { tokens, ...manifest } = skin
      delete (manifest as Partial<Skin>).bundled
      // Only validated data is copied. CSS is flattened; unrelated package files never enter Clave.
      delete manifest.skin.css
      writeFileSync(join(staging, 'clave-plugin.json'), JSON.stringify(manifest, null, 2))
      writeFileSync(join(staging, 'skin.json'), JSON.stringify(tokens, null, 2))
      renameSync(staging, target)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    return this.activate(skin.id)
  }

  remove(id: string): SkinState {
    const skin = this.list().skins.find((s) => s.id === id)
    if (!skin || skin.bundled) throw new Error('Only installed skins can be removed')
    rmSync(join(this.root, skin.id), { recursive: true })
    return this.publish()
  }

  private publish(): SkinState {
    const state = this.list()
    this.changed(state)
    return state
  }
  private refreshIfChanged(): void {
    const state = this.list()
    const fingerprint = JSON.stringify(state)
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.changed(state)
    }
  }

  startWatching(): void {
    this.fingerprint = JSON.stringify(this.list())
    this.watcher = watch(this.root, { recursive: true }, () => {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.refreshIfChanged(), 150)
    })
    // Native recursive watchers can miss edits while their directory watches
    // are being established (notably on macOS). Reconcile content as well.
    this.poll = setInterval(() => this.refreshIfChanged(), 1000)
    this.poll.unref()
  }
  close(): void {
    clearTimeout(this.timer)
    clearInterval(this.poll)
    this.watcher?.close()
  }
}
