/** The helper resolves every component with openat(O_NOFOLLOW), from an open
 * directory descriptor. Authorized path strings must never be reopened by
 * ordinary Node fs calls after realpath: the parent can have changed. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FileOperationFailed, MAX_FILE_ENTRIES } from '@clave/contract/files'
import type { FileInfo } from '@clave/contract/files'

interface NativeListing {
  entries: { name: string; type: 'file' | 'directory'; size: number }[]
  truncated: boolean
}
interface NativeRead {
  bytes: Buffer
  size: number
}
const helperPath = (): string => {
  let parent = __dirname
  for (let level = 0; level < 7; level += 1) {
    const path = join(parent, 'resources/native/secure-files-helper').replace(
      'app.asar/',
      'app.asar.unpacked/'
    )
    if (existsSync(path)) return path
    parent = dirname(parent)
  }
  throw new FileOperationFailed({
    code: 'io',
    message: 'The secure file helper is unavailable. Build the native helpers first.'
  })
}
const run = (operation: string, path: string, limit = 0, input?: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let helper: string
    try {
      helper = helperPath()
    } catch (error) {
      reject(error)
      return
    }
    const child = spawn(helper, [operation, path, String(limit)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {}
    })
    const chunks: Buffer[] = []
    let length = 0
    let errorText = ''
    let settled = false
    const finish = (error?: FileOperationFailed): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks, length))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(
        new FileOperationFailed({ code: 'io', message: 'The secure file operation timed out.' })
      )
    }, 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      length += chunk.length
      const maximum = operation === 'list' ? MAX_FILE_ENTRIES * 2048 + 4096 : limit + 4096
      if (length > maximum) {
        child.kill('SIGKILL')
        finish(
          new FileOperationFailed({
            code: 'too_large',
            message: 'The file operation exceeded its output limit.'
          })
        )
      } else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errorText += chunk.toString('utf8').slice(0, Math.max(0, 1024 - errorText.length))
    })
    child.stdin.on('error', () => {
      /* The helper can refuse a path before reading stdin. Exit owns the error. */
    })
    child.on('error', () =>
      finish(
        new FileOperationFailed({ code: 'io', message: 'The secure file helper could not start.' })
      )
    )
    child.on('close', (code) => {
      if (code === 0) finish()
      else {
        const known = [
          'invalid_path',
          'too_large',
          'not_found',
          'invalid_data',
          'not_file',
          'io'
        ] as const
        const domainCode = known.find((value) => errorText.trim() === value) ?? 'io'
        finish(
          new FileOperationFailed({
            code: domainCode,
            message: 'The secure file operation was refused or failed.'
          })
        )
      }
    })
    child.stdin.end(input)
  })
const metadata = async <A>(operation: string, path: string): Promise<A> =>
  JSON.parse((await run(operation, path)).toString('utf8')) as A
export const secureFiles = {
  stat: (path: string): Promise<FileInfo> => metadata('stat', path),
  list: (path: string): Promise<NativeListing> => metadata('list', path),
  async read(path: string, limit: number): Promise<NativeRead> {
    const output = await run('read', path, limit)
    const newline = output.indexOf(10)
    if (newline < 0 || newline > 4096) throw new Error('Invalid secure read response.')
    const header = JSON.parse(output.subarray(0, newline).toString('utf8')) as { size: number }
    return { bytes: output.subarray(newline + 1), size: header.size }
  },
  async write(path: string, bytes: Buffer): Promise<void> {
    await run('write', path, bytes.length, bytes)
  },
  async create(path: string, bytes: Buffer = Buffer.alloc(0)): Promise<void> {
    await run('create', path, bytes.length, bytes)
  },
  async mkdir(path: string): Promise<void> {
    await run('mkdir', path)
  },
  async mkdirp(path: string): Promise<void> {
    await run('mkdirp', path)
  }
}
