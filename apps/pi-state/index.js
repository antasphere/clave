/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Clave's bundled Pi lifecycle adapter. Pi loads this file with --extension.
// Source contract: https://pi.dev/docs/extensions
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export default function claveState(pi) {
  const stateFile = process.env.CLAVE_AGENT_STATE_FILE
  if (!stateFile) return

  const write = (state) => {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, state, 'utf8')
    } catch {
      // State reporting is optional. It must never interrupt the Pi session.
    }
  }

  pi.on('session_start', () => write('idle'))
  pi.on('before_agent_start', () => write('working'))
  pi.on('agent_start', () => write('working'))
  pi.on('agent_end', () => write('done'))
  pi.on('session_shutdown', () => write('ended'))
}
