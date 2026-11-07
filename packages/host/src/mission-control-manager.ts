import { app, BrowserWindow } from 'electron'
import { spawn, ChildProcessByStdio } from 'child_process'
import type { Readable, Writable } from 'stream'
import { createInterface } from 'readline'
import { join } from 'path'
import { focusedOrPrimaryWindow } from './window-routing'
import { preferencesManager } from './preferences-manager'

/**
 * Shows a "Clave is here" overlay while macOS Mission Control is active,
 * like Granola. A small native helper (resources/native/mission-control-helper)
 * watches the window server's transform of our window and reports
 * entered/exited over stdout; we relay those to the renderer.
 */

const RESPAWN_BACKOFF_INITIAL = 1000
const RESPAWN_BACKOFF_MAX = 30_000
const MINIMIZE_SUPPRESS_MS = 800

type HelperProcess = ChildProcessByStdio<Writable, Readable, null>

let child: HelperProcess | null = null
let registered: boolean | null = null
let killed = false
let backoffMs = RESPAWN_BACKOFF_INITIAL
let respawnTimer: ReturnType<typeof setTimeout> | null = null
let suppressUntil = 0

function helperPath(): string {
  const base = join(__dirname, '../../resources/native')
  const asarUnpacked = base.replace('app.asar', 'app.asar.unpacked')
  return join(asarUnpacked, 'mission-control-helper')
}

function sendToRenderer(channel: string): void {
  // The overlay follows the focused window (else primary): Mission Control
  // shows one window's transform at a time.
  focusedOrPrimaryWindow()?.webContents.send(channel)
}

function forwardEntered(): void {
  const win = focusedOrPrimaryWindow()
  if (!win || win.isMinimized() || Date.now() < suppressUntil) return
  sendToRenderer('mission-control:entered')
}

function forceHide(): void {
  sendToRenderer('mission-control:exited')
}

function writeCommand(cmd: Record<string, unknown>): void {
  try {
    child?.stdin.write(JSON.stringify(cmd) + '\n')
  } catch {
    // Broken pipe on a dying child — the exit handler deals with it.
  }
}

/** Tell the helper which window to watch. CGWindowID comes from getMediaSourceId(). */
export function sendTargetWindow(): void {
  if (!child) return
  const sourceId = focusedOrPrimaryWindow()?.getMediaSourceId()
  const match = sourceId?.match(/^window:(\d+):/)
  if (match) {
    writeCommand({ cmd: 'set-target-window', windowId: Number(match[1]) })
  }
}

function spawnHelper(): void {
  if (child || killed) return
  let proc: HelperProcess
  try {
    proc = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] })
  } catch (err) {
    console.error('[mission-control] failed to spawn helper:', err)
    return
  }
  child = proc

  createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg: { event?: string; registered?: boolean }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    switch (msg.event) {
      case 'initialized':
        registered = msg.registered === true
        if (registered) {
          backoffMs = RESPAWN_BACKOFF_INITIAL
          sendTargetWindow()
        } else {
          console.log('[mission-control] helper reported unsupported OS, disabling')
        }
        break
      case 'entered':
        sendTargetWindow() // keep the target fresh, Granola-style
        forwardEntered()
        break
      case 'exited':
        sendToRenderer('mission-control:exited')
        break
    }
  })

  proc.on('error', (err) => {
    console.error('[mission-control] helper error:', err)
  })

  proc.on('exit', (code) => {
    if (child !== proc) return
    child = null
    forceHide()
    // registered === false means the OS lacks the private API — don't retry.
    if (killed || registered === false) return
    if (code !== 0) console.error(`[mission-control] helper exited with code ${code}`)
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      spawnHelper()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, RESPAWN_BACKOFF_MAX)
  })
}

function killHelper(): void {
  if (respawnTimer) {
    clearTimeout(respawnTimer)
    respawnTimer = null
  }
  if (child) {
    const proc = child
    child = null
    try {
      proc.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n')
    } catch {
      // already gone
    }
    setTimeout(() => {
      if (!proc.killed) proc.kill()
    }, 500)
  }
  forceHide()
}

/** Suppress the overlay around minimize (the genie animation also scales the window). */
export function attachMissionControlWindow(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  win.on('minimize', () => {
    suppressUntil = Date.now() + MINIMIZE_SUPPRESS_MS
    forceHide()
  })
  win.on('restore', () => sendTargetWindow())
  // The CGWindowID can change when the window is shown; re-send once visible.
  win.once('show', () => sendTargetWindow())
}

export function initMissionControl(): void {
  if (process.platform !== 'darwin') return
  if (!preferencesManager.get('missionControlOverlayEnabled')) return
  spawnHelper()
}

export function cleanupMissionControl(): void {
  killed = true
  killHelper()
}

export function isMissionControlEnabled(): boolean {
  return preferencesManager.get('missionControlOverlayEnabled')
}

export function setMissionControlEnabled(enabled: boolean): void {
  preferencesManager.set('missionControlOverlayEnabled', enabled)
  if (process.platform !== 'darwin') return
  if (enabled) {
    killed = false
    registered = null
    backoffMs = RESPAWN_BACKOFF_INITIAL
    spawnHelper()
  } else {
    killHelper()
  }
}

/** Dev-only hook so the renderer overlay can be tested deterministically. */
export function simulateMissionControl(entered: boolean): void {
  if (app.isPackaged) return
  sendToRenderer(entered ? 'mission-control:entered' : 'mission-control:exited')
}
