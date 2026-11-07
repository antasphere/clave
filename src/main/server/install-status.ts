/**
 * What `install-server.sh` writes to its status file (`CLAVE_INSTALL_STATUS_FILE`):
 * `phase=<phase>` as each phase starts and `code=<code>` where it fails, both
 * from the contract's closed lists, and nothing else is ever read off it.
 * Read by the daemon's self-upgrade (`self-upgrade.ts`) and by the app when
 * it installs this Mac as a server (`server-setup/install.ts`). The lists
 * come from a contract module with no Effect in it, so main's boot can reach
 * this file (`lazy-load.test.ts` holds that line).
 */
import type { ServerUpgradeFailure } from '@clave/contract/server-info'
import {
  isServerUpgradeFailureCode,
  isServerUpgradePhase,
  type ServerUpgradeFailureCode,
  type ServerUpgradePhase
} from '@clave/contract/upgrade-failure'

const STATUS_LINE = /^(code|phase)=([a-z-]+)$/

/**
 * What a run's status file says: the last code and the last phase it names
 * from the contract's lists. Every other line (text, a value off the lists,
 * a carriage return) is ignored, so nothing but those values is ever read.
 */
export function readRunStatus(text: string | null): {
  code?: ServerUpgradeFailureCode
  phase?: ServerUpgradePhase
} {
  let code: ServerUpgradeFailureCode | undefined
  let phase: ServerUpgradePhase | undefined
  for (const line of (text ?? '').split('\n')) {
    const match = STATUS_LINE.exec(line)
    if (!match) continue
    const [, key, value] = match
    if (key === 'code' && isServerUpgradeFailureCode(value)) code = value
    if (key === 'phase' && isServerUpgradePhase(value)) phase = value
  }
  return { ...(code && { code }), ...(phase && { phase }) }
}

/** A run's failure as it leaves the server: `unknown` when the script wrote no code. */
export function runFailure(
  status: string | null,
  exitCode: number,
  logPath: string
): ServerUpgradeFailure {
  const said = readRunStatus(status)
  return {
    code: said.code ?? 'unknown',
    ...(said.phase && { phase: said.phase }),
    exitCode,
    logPath
  }
}
