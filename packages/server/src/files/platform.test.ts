import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { ensureFileHelper } from './test-support'

beforeAll(ensureFileHelper, 30_000)
for (const operation of ['create', 'write'] as const) {
  test(`native ${operation} uses the already opened parent after it is replaced`, async () => {
    const scratch = '/tmp/clave-vps-c-impl/fix1'
    await mkdir(scratch, { recursive: true })
    const base = await realpath(await mkdtemp(join(scratch, 'native-fd-')))
    const folder = join(base, 'folder')
    const outside = join(base, 'outside')
    const parked = join(base, 'parked')
    await mkdir(folder)
    await mkdir(outside)
    await writeFile(join(outside, 'target'), 'outside unchanged')
    if (operation === 'write') await writeFile(join(folder, 'target'), 'inside before')
    const bytes = Buffer.from('inside after')
    const child = spawn(
      resolve(__dirname, '../../../../resources/native/secure-files-helper'),
      [operation, join(folder, 'target'), String(bytes.length)],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const closed = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', resolveExit)
    })
    child.stdin.on('error', () => {})
    child.stdout.resume()
    child.stderr.resume()
    try {
      const deadline = Date.now() + 3000
      let opened = false
      while (Date.now() < deadline) {
        const names = await readdir(folder)
        opened =
          operation === 'create'
            ? names.includes('target')
            : names.some((name) => name.startsWith('.clave-'))
        if (opened) break
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
      }
      expect(opened).toBe(true)
      await rename(folder, parked)
      await symlink(outside, folder)
      child.stdin.end(bytes)
      expect(await closed).toBe(0)
      expect(await readFile(join(parked, 'target'), 'utf8')).toBe('inside after')
      expect(await readFile(join(outside, 'target'), 'utf8')).toBe('outside unchanged')
      expect(await readdir(outside)).toEqual(['target'])
    } finally {
      child.kill('SIGKILL')
      await closed.catch(() => {})
      await rm(base, { recursive: true, force: true })
    }
  }, 10_000)
}

test('native create rejects excess stdin and removes its partial output', async () => {
  const base = await realpath(await mkdtemp('/tmp/clave-vps-c-impl/fix1/native-limit-'))
  const path = join(base, 'target')
  const child = spawn(
    resolve(__dirname, '../../../../resources/native/secure-files-helper'),
    ['create', path, '1'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let error = ''
  child.stdout.resume()
  child.stderr.on('data', (value: Buffer) => {
    error += value.toString()
  })
  const closed = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', resolveExit)
  })
  child.stdin.on('error', () => {})
  child.stdin.end('too much')
  try {
    expect(await closed).toBe(1)
    expect(error.trim()).toBe('too_large')
    expect(await readdir(base)).toEqual([])
  } finally {
    child.kill('SIGKILL')
    await closed.catch(() => {})
    await rm(base, { recursive: true, force: true })
  }
})
