import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { localAttachmentUpload, remoteDownloadBytes, saveRemoteDownload } from './file-transfers'

let directory: string
beforeEach(async () => {
  const scratch = '/tmp/clave-vps-c-impl'
  await mkdir(scratch, { recursive: true })
  directory = await mkdtemp(join(scratch, 'transfer-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

test('converts a local file to bytes without forwarding its Mac path', async () => {
  const path = join(directory, 'file.txt')
  await writeFile(path, 'selected on Mac')
  expect(await localAttachmentUpload({ path })).toEqual({
    kind: 'upload',
    name: 'file.txt',
    image: false,
    base64: Buffer.from('selected on Mac').toString('base64')
  })
  await expect(localAttachmentUpload({ path, bytes: new Uint8Array([1]) })).rejects.toThrow(
    'one attachment source'
  )
  await expect(localAttachmentUpload({ path: 'relative' })).rejects.toThrow('local file')
})

test('refuses corrupt, oversized or path-bearing downloads before writing', async () => {
  for (const input of [
    { name: '../escape', base64: 'YQ==', size: 1 },
    { name: 'C:\\escape', base64: 'YQ==', size: 1 },
    { name: 'ok', base64: 'YR==', size: 1 },
    { name: 'ok', base64: 'YQ==', size: 99 },
    { name: 'ok', base64: 'YQ==', size: -1 }
  ]) {
    await expect(saveRemoteDownload(directory, input)).rejects.toThrow()
  }
  expect(await readdir(directory)).toEqual([])
})

test('validates actual bytes and writes distinct private copies', async () => {
  const input = { name: 'notes.txt', base64: 'YQ==', size: 1 }
  expect(remoteDownloadBytes(input)).toEqual({ name: 'notes.txt', bytes: Buffer.from('a') })
  const one = await saveRemoteDownload(directory, input)
  const two = await saveRemoteDownload(directory, input)
  expect(one).not.toBe(two)
  expect(await readFile(one, 'utf8')).toBe('a')
  expect(await readFile(two, 'utf8')).toBe('a')
})

test('opens a maximum-length remote filename without exceeding the local filesystem limit', async () => {
  const path = await saveRemoteDownload(directory, {
    name: 'x'.repeat(251) + '.txt',
    base64: 'YQ==',
    size: 1
  })
  expect(path.endsWith('.txt')).toBe(true)
  expect(await readFile(path, 'utf8')).toBe('a')
})
