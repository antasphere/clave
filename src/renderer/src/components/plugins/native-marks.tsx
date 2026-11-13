import { useMemo } from 'react'
import { OrbsAgent, OrbsSettings, OrbsTool } from '../../../../../plugins/orbs/src/pack'
import { useRegistry } from '../../views/store'
import { useSessionStore } from '../../store/session-store'
import { availableMarks, resolveMark, LOGO_MARK, type MarkPack } from '../../lib/marks'

/** Bundled mark packs, keyed like native views and panels: `<pluginId>/<markId>`.
 *  A pack here is one the app ships and compiles into the renderer; the
 *  manifest still declares it, so enabling and disabling are the plugin
 *  host's — only the drawing is native (`lib/marks.ts`). */
export const nativeMarks: Record<string, MarkPack> = {
  'clave.orbs/orbs': { Agent: OrbsAgent, Tool: OrbsTool, Settings: OrbsSettings }
}

/** What this build can draw, handed to the pure resolution in `lib/marks.ts`. */
export const implementedMarks: ReadonlySet<string> = new Set(Object.keys(nativeMarks))

/** The pack the user chose, if its plugin can draw it right now; null for the
 *  logo. Read by every slot that draws an agent or a running tool. */
export function useMarkPack(): MarkPack | null {
  const saved = useSessionStore((s) => s.agentMark)
  const plugins = useRegistry((s) => s.plugins)
  return useMemo(() => {
    const id = resolveMark(saved, availableMarks(plugins, implementedMarks))
    return id === LOGO_MARK ? null : (nativeMarks[id] ?? null)
  }, [saved, plugins])
}
