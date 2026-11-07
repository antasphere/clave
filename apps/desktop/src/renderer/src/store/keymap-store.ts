import { create } from 'zustand'
import {
  formatKeyBinding,
  parseKeymapOverrides,
  resolveKeymapConfig,
  type KeymapActionId,
  type KeymapOverridesV1,
  type KeymapValidationError,
  type ResolvedKeymapConfig
} from '../../../../../../packages/shared/src/keymaps'

interface KeymapState {
  config: ResolvedKeymapConfig
  overrides: KeymapOverridesV1
  loaded: boolean
  error: string | null
}

const EMPTY_OVERRIDES: KeymapOverridesV1 = { version: 1 }

export const useKeymapStore = create<KeymapState>(() => ({
  config: resolveKeymapConfig(),
  overrides: EMPTY_OVERRIDES,
  loaded: false,
  error: null
}))

function validationMessage(errors: KeymapValidationError[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join('\n')
}

function applyRaw(raw: unknown): boolean {
  const candidate = raw === null ? EMPTY_OVERRIDES : raw
  const parsed = parseKeymapOverrides(candidate)
  if (!parsed.ok) {
    useKeymapStore.setState({ loaded: true, error: validationMessage(parsed.errors) })
    return false
  }
  useKeymapStore.setState({
    config: resolveKeymapConfig(parsed.value),
    overrides: parsed.value,
    loaded: true,
    error: null
  })
  return true
}

export async function loadKeymaps(): Promise<void> {
  try {
    applyRaw((await window.electronAPI?.keymapsLoad?.()) ?? null)
  } catch (error) {
    useKeymapStore.setState({
      loaded: true,
      error: error instanceof Error ? error.message : 'Failed to load keymaps'
    })
  }
}

/** Connect one renderer window to main's accepted configuration. The pull
 * closes the startup race; the push keeps every already-open window current. */
export function connectKeymapStore(): () => void {
  void loadKeymaps()
  return (
    window.electronAPI?.onKeymapsChanged?.((raw) => {
      applyRaw(raw)
    }) ?? (() => {})
  )
}

export async function saveKeymapOverrides(
  raw: unknown
): Promise<
  | { ok: true; value: KeymapOverridesV1 }
  | { ok: false; errors: KeymapValidationError[] | [{ path: '$'; message: string }] }
> {
  const parsed = parseKeymapOverrides(raw)
  if (!parsed.ok) return parsed
  try {
    const accepted = await window.electronAPI.keymapsSave(parsed.value)
    const acceptedParsed = parseKeymapOverrides(accepted)
    if (!acceptedParsed.ok) return acceptedParsed
    applyRaw(acceptedParsed.value)
    return { ok: true, value: acceptedParsed.value }
  } catch (error) {
    return {
      ok: false,
      errors: [
        { path: '$', message: error instanceof Error ? error.message : 'Failed to save keymaps' }
      ]
    }
  }
}

export function shortcutLabel(actionId: KeymapActionId): string | null {
  const { config } = useKeymapStore.getState()
  const binding = config.bindings[actionId][0]
  return binding ? formatKeyBinding(binding, config.masterKey) : null
}

export function useShortcutLabel(actionId: KeymapActionId): string | null {
  return useKeymapStore((state) => {
    const binding = state.config.bindings[actionId][0]
    return binding ? formatKeyBinding(binding, state.config.masterKey) : null
  })
}
