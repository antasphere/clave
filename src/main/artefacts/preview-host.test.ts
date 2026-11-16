import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREVIEW_HOST_SOURCE, previewHostPath, writePreviewHost } from './preview-host'

/**
 * A preview ends with the process that started it (PRDCT-4472), with real
 * processes and no Slideless: a stand-in CLI (an ES module, as the real one
 * is) that listens on the port it is given, prints the address line and
 * stays up; a parent that starts it under the preview host the way the
 * preview servers do, then is killed with SIGKILL, which runs no cleanup of
 * its own. The child must be gone within three seconds.
 */
const FIXTURE_CLI = `
import { createServer } from 'node:http'
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + port + '/' }))
})
`

/** Starts the guarded child as \`PreviewServers\` does, says its pid, stays up. */
const PARENT = `
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
const [host, cli, target] = process.argv.slice(2)
const probe = createServer().listen(0, '127.0.0.1', () => {
  const port = probe.address().port
  probe.close(() => {
    const child = spawn(process.execPath, [host, cli, 'dev', target, '--port', String(port), '--no-open', '--json'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('"url"')) process.stdout.write(JSON.stringify({ pid: child.pid }) + '\\n')
    })
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  })
})
setInterval(() => {}, 1000)
`

const dirs: string[] = []
const pids: number[] = []
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'clave-preview-host-'))
  dirs.push(dir)
  return dir
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('the preview host', () => {
  it('is written under the data folder, owner-only, and again only when it differs', () => {
    const dir = tmp()
    const file = writePreviewHost(dir)
    expect(file).toBe(previewHostPath(dir))
    expect(file).toBe(join(dir, 'slideless', 'preview-host.mjs'))
    expect(readFileSync(file, 'utf8')).toBe(PREVIEW_HOST_SOURCE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const written = statSync(file).mtimeMs
    writePreviewHost(dir)
    expect(statSync(file).mtimeMs).toBe(written)
    writeFileSync(file, '// an older host\n')
    writePreviewHost(dir)
    expect(readFileSync(file, 'utf8')).toBe(PREVIEW_HOST_SOURCE)
  })

  it('ends the preview within three seconds of its parent being killed with SIGKILL', async () => {
    const dir = tmp()
    const host = writePreviewHost(dir)
    const cli = join(dir, 'fixture-cli.mjs')
    writeFileSync(cli, FIXTURE_CLI)
    const parentFile = join(dir, 'parent.mjs')
    writeFileSync(parentFile, PARENT)
    const parent = spawn(process.execPath, [parentFile, host, cli, dir], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    pids.push(parent.pid!)
    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the preview did not start')), 10_000)
      let errors = ''
      parent.stderr.on('data', (chunk) => (errors += String(chunk)))
      parent.on('exit', () => reject(new Error(`the parent ended: ${errors}`)))
      parent.stdout.on('data', (chunk) => {
        const line = String(chunk).trim().split('\n')[0]!
        clearTimeout(timer)
        resolve((JSON.parse(line) as { pid: number }).pid)
      })
    })
    pids.push(childPid)
    expect(alive(childPid)).toBe(true)
    parent.kill('SIGKILL')
    await expect.poll(() => alive(childPid), { timeout: 3_000, interval: 50 }).toBe(false)
  }, 15_000)
})
