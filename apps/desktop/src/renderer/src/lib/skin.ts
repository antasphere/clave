import { setTerminalSkin } from './terminal-theme'
import { create } from 'zustand'
import tokenNames from '@clave/skins/token-names.json'
import { bundledSkins } from '@clave/skins/bundled'
import type { Skin, SkinState } from '@clave/skins/types'
import { useSessionStore, type Theme } from '../store/session-store'

export const useSkinStore = create<SkinState & { revision: number; error: string | null }>(() => ({
  skins: bundledSkins,
  activeId: null,
  errors: [],
  revision: 0,
  error: null
}))
let appliedKeys: string[] = []
let editorKeys: string[] = []

export function applySkin(tokens: Record<string, string>): void {
  const root = document.documentElement
  for (const key of appliedKeys) root.style.removeProperty(key)
  // This preference remains owned by the tree-separator control.
  appliedKeys = Object.keys(tokens).filter(
    (key) => tokenNames.includes(key) && key !== '--rule-intensity'
  )
  for (const key of appliedKeys) root.style.setProperty(key, tokens[key])
  setTerminalSkin(tokens)
  useSkinStore.setState((s) => ({ revision: s.revision + 1 }))
}

function receive(state: SkinState): void {
  const skin = state.skins.find((s) => s.id === state.activeId)
  if (skin) {
    const root = document.documentElement
    // CodeMirror still owns its theme tokens in app CSS during this transition.
    // Resolve those from the bundled theme before mapping data-theme to its base.
    for (const key of editorKeys) root.style.removeProperty(key)
    root.dataset.theme = skin.bundled ? skin.id : skin.skin.base
    const styles = getComputedStyle(root)
    editorKeys = Array.from(styles).filter((key) => key.startsWith('--cm-'))
    const editorTokens = editorKeys.map((key) => [key, styles.getPropertyValue(key)])
    root.dataset.theme = skin.skin.base
    for (const [key, value] of editorTokens) root.style.setProperty(key, value)
    applySkin(skin.tokens)
    const theme = (skin.bundled ? skin.id : skin.skin.base) as Theme
    useSessionStore.setState({ theme })
    localStorage.setItem('clave-theme', theme)
  }
  useSkinStore.setState(state)
}

export async function skinAction(action: () => Promise<SkinState>): Promise<void> {
  try {
    receive(await action())
    useSkinStore.setState({ error: null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    useSkinStore.setState({
      error: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    })
  }
}

export function initializeSkins(): () => void {
  const unsubscribe = window.electronAPI.onSkinsChanged(receive)
  void skinAction(async () => {
    const state = await window.electronAPI.skinsList()
    if (!state.activeId) {
      const legacyTheme = useSessionStore.getState().theme
      // Preserve the legacy appearance without recording a choice the user never made.
      return {
        ...state,
        activeId: state.skins.some((skin) => skin.id === legacyTheme) ? legacyTheme : 'dark'
      }
    }
    return state
  })
  return unsubscribe
}

export function activeSkin(): Skin | undefined {
  const state = useSkinStore.getState()
  return state.skins.find((s) => s.id === state.activeId)
}
