import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Writable } from 'stream'
import { join } from 'path'

/**
 * Trackpad haptic ticks. Electron cannot reach NSHapticFeedbackManager, so a
 * resident Swift helper (resources/native/haptic-helper, same build as the
 * mission-control one) performs a pattern per line written to its stdin. The
 * helper is spawned on the first tick and kept for the app's lifetime; if it
 * dies it is simply respawned on the next tick. Anything failing here is a
 * missing nicety, never an error the user should see — every path swallows.
 */
export type HapticPattern = 'alignment' | 'generic' | 'level'

type Helper = ChildProcessByStdio<Writable, null, null>

let child: Helper | null = null
let unavailable = false

function helperPath(): string {
  const base = join(__dirname, '../../resources/native')
  return join(base.replace('app.asar', 'app.asar.unpacked'), 'haptic-helper')
}

function ensureHelper(): Helper | null {
  if (child) return child
  if (unavailable || process.platform !== 'darwin') return null
  try {
    const proc = spawn(helperPath(), [], { stdio: ['pipe', 'ignore', 'ignore'] })
    proc.on('error', () => {
      // ENOENT (helper not built) or a spawn failure: stop trying this run.
      unavailable = true
      child = null
    })
    proc.on('exit', () => {
      child = null
    })
    child = proc
    return proc
  } catch {
    unavailable = true
    return null
  }
}

/** Perform one haptic pattern. Fire-and-forget; silent when unsupported. */
export function hapticTick(pattern: HapticPattern = 'alignment'): void {
  const proc = ensureHelper()
  if (!proc) return
  try {
    proc.stdin.write(`${pattern}\n`)
  } catch {
    // A dying child: the exit handler clears it; the next tick respawns.
  }
}

export function stopHapticHelper(): void {
  try {
    child?.stdin.end()
    child?.kill()
  } catch {
    /* already gone */
  }
  child = null
}
