/**
 * A pinned group as the workspace state file persists it (the renderer's
 * `PinnedGroupBlueprint`, `src/renderer/src/store/pinned-store.ts`, field
 * by field for what a LAUNCH needs): the shape main reads when an agent
 * launches a pinned group through the server (wave 4, PRDCT-3377). The
 * renderer's type is assignable to this one; the runtime link to a live
 * group (`activeGroupId`, `visible`) is the window's own and is not here.
 */
export interface PinnedBlueprintSession {
  cwd: string
  name: string
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  piMode?: boolean
  claudeAgentsMode?: boolean
  dangerousMode: boolean
  prompt?: string
  rootSession?: boolean
  /** The account by LABEL, or `any` for the pool's pick (ADR 0002). */
  account?: string
}

export interface PinnedBlueprintTerminal {
  command: string
  commandMode: 'prefill' | 'auto'
  color: string
  icon?: string
  cwd?: string | null
  autoLaunchLocalhost?: boolean
  serverUrl?: string
  groupView?: boolean
}

export interface PinnedBlueprint {
  id: string
  name: string
  cwd: string | null
  color?: string | null
  prompt?: string | null
  /** A page the group shows that needs no process (an http(s) URL or an .html file). */
  view?: string | null
  sessions: PinnedBlueprintSession[]
  terminals: PinnedBlueprintTerminal[]
  rootDir?: string | null
  workspaceRoot?: string | null
  workspaceId?: string | null
}
