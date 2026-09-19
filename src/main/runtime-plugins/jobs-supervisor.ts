/**
 * Static Node source, bundled as data so packaged Electron needs no extra entry.
 * Only the owning daemon holds the IPC endpoint. Renderer disconnects and app
 * quit do not close it. Request argv/env travel over IPC, never supervisor argv.
 *
 * On POSIX the supervisor remains the group leader until it kills the entire
 * group, including itself. This avoids signalling a reaped/reused command PID.
 * Commands must not deliberately escape with setsid/detached process groups.
 * This is lifecycle ownership for trusted native code, not an OS sandbox.
 */
export const JOB_SUPERVISOR_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process')
let finishing = false
let started = false
let timer
const killGroup = () => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 5000
    })
    process.exit(1)
  }
  process.kill(-process.pid, 'SIGKILL')
}
const finish = (code, interrupted = false) => {
  if (finishing) return
  finishing = true
  clearTimeout(timer)
  // Reporting is bounded even if the daemon no longer services its IPC pipe.
  setTimeout(killGroup, 100).unref()
  if (process.connected) {
    process.send({ code, interrupted }, () => killGroup())
  } else killGroup()
}
process.on('disconnect', killGroup)
process.on('SIGTERM', killGroup)
process.on('SIGINT', killGroup)
process.on('uncaughtException', killGroup)
// Bound a supervisor whose owner never sends its initial request.
timer = setTimeout(() => finish(null, true), 10000)
process.on('message', (input) => {
  if (!process.connected) return killGroup()
  if (input.cancel) return killGroup()
  if (started || finishing) return
  started = true
  clearTimeout(timer)
  timer = setTimeout(() => finish(null, true), input.timeoutMs)
  try {
    const command = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd, env: input.env, shell: false, detached: false,
      stdio: ['ignore', 'inherit', 'inherit']
    })
    command.once('error', () => finish(null))
    // Do not wait for close: descendants can inherit or redirect stdio.
    command.once('exit', (code) => finish(code))
  } catch {
    finish(null)
  }
})
// Cancellation can close IPC before Node has evaluated this source.
if (!process.connected) killGroup()
`
