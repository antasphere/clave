/**
 * Appearance → Agent mark: what stands for an agent in the chrome, and for a
 * tool call in flight.
 *
 * `logo` is the provider's brand mark (Claude, Codex, Pi, Antigravity) on the
 * agent and the kind's glyph on the tool: the default, what the app always
 * drew. Anything else is a MARK PACK a plugin contributes
 * (`contributes.marks[]` in the plugin SDK): a set of React components the
 * app mounts in the logo's slots. Packs are native — code compiled into the
 * renderer and mapped by `<pluginId>/<markId>` in
 * `components/plugins/native-marks.tsx`, the way bundled views and panels
 * are — so only a bundled, enabled plugin can draw one. The choice is saved as
 * the raw id and resolved at use: a pack whose plugin is disabled, gone, or
 * not carried by this build falls back to the logo instead of an empty slot.
 */
import type { ComponentType } from 'react'
import type { PluginRecord } from '../../../main/plugins/plugin-store'

export const LOGO_MARK = 'logo'

/** What the app tells a pack about the agent it is drawing. `status` is the
 *  tab's (`lib/tab-status.ts`) or the pane's; `color` is the status ink the
 *  app would paint the logo in, when there is one; `slot` says where. */
export interface AgentMarkProps {
  working: boolean
  status: string
  color?: string
  slot: 'tab' | 'pane' | 'transcript' | 'sample'
}

/** A tool call: the chat view's kind (`plugins/chat-view/src/tools.ts`) and
 *  whether it still runs. A pack draws the running call; a finished one keeps
 *  the app's own glyph. */
export interface ToolMarkProps {
  kind: string
  running: boolean
}

export interface MarkPack {
  Agent: ComponentType<AgentMarkProps>
  /** Absent when the pack declares no `tool` slot. */
  Tool?: ComponentType<ToolMarkProps>
  /** The pack's own settings, rendered under the Agent mark row while chosen. */
  Settings?: ComponentType
}

export interface AvailableMark {
  id: string
  title: string
  pluginName: string
  slots: ReadonlyArray<'agent' | 'tool'>
}

/** The same bar as a native view (`views/resolution.ts`): bundled, enabled,
 *  running or starting, no error, native UI. No session permission: a mark
 *  reads nothing. */
function eligible(plugin: PluginRecord): boolean {
  return (
    plugin.source === 'bundled' &&
    plugin.enabled &&
    (plugin.status === 'active' || plugin.status === 'starting') &&
    !plugin.error &&
    plugin.manifest?.ui === 'native'
  )
}

/** Every pack this build can draw, in manifest order: what Appearance lists
 *  beside the logo. `implemented` says which `<pluginId>/<markId>` the host
 *  carries, so a manifest declaring a pack the build does not have is never
 *  offered. */
export function availableMarks(
  plugins: PluginRecord[],
  implemented: ReadonlySet<string>
): AvailableMark[] {
  return plugins.flatMap((plugin) => {
    if (!eligible(plugin)) return []
    return (plugin.manifest?.contributes.marks ?? [])
      .filter((mark) => implemented.has(`${plugin.id}/${mark.id}`))
      .map((mark) => ({
        id: `${plugin.id}/${mark.id}`,
        title: mark.title,
        pluginName: plugin.manifest?.name ?? plugin.id,
        slots: mark.slots
      }))
  })
}

/** The saved choice against what can be drawn: the pack's id, or the logo. */
export function resolveMark(saved: string | null, available: AvailableMark[]): string {
  if (!saved || saved === LOGO_MARK) return LOGO_MARK
  return available.some((mark) => mark.id === saved) ? saved : LOGO_MARK
}

/** The literal value of a colour token on the root, for an ink a pack can
 *  take (`#rrggbb` / `rgb()`); undefined when the token is not set, which
 *  leaves the mark in the skin's ink rather than tinting it wrongly. */
export function tokenColor(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || undefined
}
