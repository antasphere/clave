import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './agent-update-manager'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('a real installer process', () => {
  it('returns what it printed and its exit code, stdin closed', async () => {
    const result = await runCommand(
      '/bin/sh',
      ['-c', 'read x; echo "got[$x]"; echo err >&2; exit 3'],
      {
        env: {},
        timeoutMs: 5_000
      }
    )
    expect(result).toEqual({ code: 3, stdout: 'got[]\n', stderr: 'err\n' })
  })

  it('is killed outright when it ignores the polite stop after its timeout', async () => {
    dir = mkdtempSync(join(tmpdir(), 'clave-run-command-'))
    const pidFile = join(dir, 'pid')
    const result = await runCommand(
      '/bin/sh',
      ['-c', `echo $$ > '${pidFile}'; trap "" TERM; exec /bin/sleep 60`],
      { env: {}, timeoutMs: 300, killGraceMs: 300 }
    )
    expect(result.failure).toMatch(/timed out/)
    const pid = Number(readFileSync(pidFile, 'utf-8'))
    expect(alive(pid)).toBe(true)
    await new Promise((r) => setTimeout(r, 900))
    expect(alive(pid)).toBe(false)
  })
})
