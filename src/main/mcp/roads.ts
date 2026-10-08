/**
 * Which road an agent tool took: the server's commands directly (`server`),
 * or a window through the server's view request (`window`). Recorded under
 * `--test-no-activate` only, on the shared end-to-end hooks namespace
 * (`globalThis.__claveE2E.mcpRoads`, `src/main/sessions/e2e-hooks.ts`), so
 * a spec can prove a tool was served and not merely answered; outside test
 * mode nothing is kept.
 */
import { TEST_NO_ACTIVATE } from '../test-mode'
import { installE2eHooks } from '../sessions/e2e-hooks'

export type ToolRoad = 'server' | 'window'
export interface RoadEntry {
  command: string
  road: ToolRoad
}

const roads: RoadEntry[] = []
let installed = false

export function noteRoad(command: string, road: ToolRoad): void {
  if (!TEST_NO_ACTIVATE) return
  if (!installed) {
    installed = true
    installE2eHooks({ mcpRoads: roads })
  }
  roads.push({ command, road })
}
