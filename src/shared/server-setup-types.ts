/**
 * The setup of a Mac as a Clave server, and the scan of its tailnet for the
 * others, shared by main, preload and renderer. Types only: the install runs
 * in main (`src/main/server-setup/`), and nothing here may carry the
 * server's token, which goes from its file straight to the saved connection
 * or the clipboard and never crosses to a window.
 */
import type { ServerUpgradeFailureCode, ServerUpgradePhase } from '@clave/contract/upgrade-failure'

/** One machine of the tailnet, and whether a Clave server answers on it. */
export interface TailnetMachine {
  name: string
  dnsName: string
  ip: string
  os: string
  online: boolean
  url: string
  claveServer: boolean
}

export type TailnetScan =
  | { available: true; self: { name: string; ip: string | null }; machines: TailnetMachine[] }
  | { available: false; reason: 'no-tailscale' | 'not-running' | 'failed' }

export type ServerServiceState = 'running' | 'stopped' | 'not-installed'

/** What this Mac has installed, read from the script's saved options. */
export interface ServerInstallStatus {
  installed: boolean
  url: string | null
  state: ServerServiceState
  tailscaleIp: string | null
  serverId: string | null
}

export type ServerInstallPhase = ServerUpgradePhase | 'starting' | 'done' | 'failed'

export interface ServerInstallProgress {
  phase: ServerInstallPhase
}

export type ServerInstallResult =
  | { ok: true; serverId: string; url: string; state: ServerServiceState }
  | {
      ok: false
      code: ServerUpgradeFailureCode
      phase?: ServerUpgradePhase
      exitCode?: number
      logPath: string
    }
