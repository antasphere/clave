import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { createApiClient, type ClaveApiClient } from '../../../client/src/api'
import { createServerFiles } from './service'
import { MAX_FILE_ENTRIES, MAX_TEXT_BYTES, MAX_TRANSFER_BYTES } from '@clave/contract/files'
import { localAttachmentUpload } from '../../../../src/main/server/file-transfers'
import { preparePrompt } from '../../../../src/main/sessions/attachments'

let root: string
let other: string
let server: EmbeddedServer
let second: EmbeddedServer
let api: ClaveApiClient
let api2: ClaveApiClient
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPwrn32nxLMMGrAqAGjBgwXAwB7Aq0fO8+5wwAAAABJRU5ErkJggg==',
  'base64'
)

beforeEach(async () => {
  const scratch = '/tmp/clave-vps-c-impl'
  await mkdir(scratch, { recursive: true })
  root = await mkdtemp(join(scratch, 'files-'))
  other = root + '-other'
  await mkdir(other)
  server = await startEmbedded({
    ports: {
      files: createServerFiles({ attachmentsRoot: join(root, 'attachments'), roots: [root] })
    }
  })
  second = await startEmbedded({
    ports: {
      files: createServerFiles({ attachmentsRoot: join(other, 'attachments'), roots: [other] })
    }
  })
  api = createApiClient({ url: server.url, token: server.token })
  api2 = createApiClient({ url: second.url, token: second.token })
})
afterEach(async () => {
  await Promise.all([api.dispose(), api2.dispose()])
  await Promise.all([server.stop(), second.stop()])
  await Promise.all([
    rm(root, { force: true, recursive: true }),
    rm(other, { force: true, recursive: true })
  ])
})

describe('authenticated owner file operations', () => {
  test('lists, reads, edits, creates, uploads and downloads actual owner disk contents', async () => {
    const location = { root, path: 'hello.txt' }
    await api.files.createDirectory({ root, path: 'folder' })
    await api.files.createFile(location)
    await api.files.write({ ...location, content: 'on first server' })
    await api2.files.write({ root: other, path: 'hello.txt', content: 'on second server' })
    expect(await api.files.read(location)).toEqual({
      content: 'on first server',
      size: 15,
      truncated: false,
      binary: false
    })
    expect(await api2.files.read({ root: other, path: 'hello.txt' })).toMatchObject({
      content: 'on second server'
    })
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('on first server')
    expect(
      (await api.files.read({ root, path: await realpath(join(root, 'hello.txt')) })).content
    ).toBe('on first server')
    expect(await readFile(join(other, 'hello.txt'), 'utf8')).toBe('on second server')
    expect(await api.files.list({ root, path: '.' })).toMatchObject({
      entries: [
        { name: 'folder', type: 'directory' },
        { name: 'hello.txt', path: 'hello.txt', size: 15 }
      ],
      truncated: false
    })
    expect(await api.files.stat(location)).toMatchObject({ type: 'file', size: 15 })
    const bytes = Buffer.from([1, 0, 2, 255])
    await api.files.upload({ root, path: 'bytes.bin', base64: bytes.toString('base64') })
    expect(await readFile(join(root, 'bytes.bin'))).toEqual(bytes)
    expect(await api.files.download({ root, path: 'bytes.bin' })).toEqual({
      name: 'bytes.bin',
      size: 4,
      base64: bytes.toString('base64')
    })
    expect(await api.files.read({ root, path: 'bytes.bin' })).toMatchObject({
      binary: true,
      content: ''
    })
    await expect(api.files.upload({ ...location, base64: '' })).rejects.toMatchObject({
      _tag: 'FileOperationFailed'
    })
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('on first server')
  })

  test('refuses wrong token and unavailable capabilities without writing', async () => {
    const wrong = createApiClient({ url: server.url, token: second.token })
    const empty = await startEmbedded({ ports: {} })
    const unavailable = createApiClient({ url: empty.url, token: empty.token })
    try {
      await expect(
        wrong.files.write({ root, path: 'bad.txt', content: 'bad' })
      ).rejects.toMatchObject({ name: 'ServerRefused' })
      await expect(stat(join(root, 'bad.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(unavailable.files.list({ root, path: '.' })).rejects.toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'files'
      })
    } finally {
      await wrong.dispose()
      await unavailable.dispose()
      await empty.stop()
    }
  })

  test('refuses lexical, sibling-prefix, root-allowlist and symlink escapes for reads and writes', async () => {
    await writeFile(join(other, 'secret'), 'keep')
    await symlink(other, join(root, 'escape'))
    await symlink(join(other, 'not-yet'), join(root, 'dangling'))
    for (const path of [
      '../' + other.split('/').pop() + '/secret',
      join(other, 'secret'),
      'escape/secret',
      'dangling'
    ]) {
      await expect(api.files.read({ root, path })).rejects.toMatchObject({
        _tag: 'FileOperationFailed'
      })
      await expect(api.files.write({ root, path, content: 'overwrite' })).rejects.toMatchObject({
        _tag: 'FileOperationFailed'
      })
    }
    await expect(
      api.files.upload({ root, path: 'escape/new', base64: 'YQ==' })
    ).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(api.files.read({ root: other, path: 'secret' })).rejects.toMatchObject({
      code: 'invalid_path'
    })
    expect(await readFile(join(other, 'secret'), 'utf8')).toBe('keep')
    await expect(stat(join(other, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await api.files.list({ root, path: '.' })).entries).toEqual([])
  })

  test('refuses special files without blocking the server', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')])
    await expect(api.files.read({ root, path: 'pipe' })).rejects.toMatchObject({ code: 'not_file' })
    await expect(api.files.download({ root, path: 'pipe' })).rejects.toMatchObject({
      code: 'not_file'
    })
    await expect(api.files.write({ root, path: 'pipe', content: 'bad' })).rejects.toMatchObject({
      code: 'not_file'
    })
    expect(await api.health.live()).toBe(true)
  })

  test('bounds reads and transfers, rejects malformed encoding and byte-sized text overflow', async () => {
    await writeFile(join(root, 'large.txt'), 'x'.repeat(MAX_TEXT_BYTES + 30))
    const read = await api.files.read({ root, path: 'large.txt' })
    expect(read.content.length).toBe(MAX_TEXT_BYTES)
    expect(read).toMatchObject({ size: MAX_TEXT_BYTES + 30, truncated: true, binary: false })
    await expect(
      api.files.write({ root, path: 'multibyte.txt', content: 'é'.repeat(MAX_TEXT_BYTES) })
    ).rejects.toMatchObject({ code: 'too_large' })
    await expect(stat(join(root, 'multibyte.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(root, 'oversize'), '')
    await truncate(join(root, 'oversize'), MAX_TRANSFER_BYTES + 1)
    await expect(api.files.download({ root, path: 'oversize' })).rejects.toMatchObject({
      code: 'too_large'
    })
    for (const base64 of ['???', 'YQ=', 'YR==', 'YQ==\n']) {
      await expect(api.files.upload({ root, path: 'bad', base64 })).rejects.toMatchObject({
        code: 'invalid_data'
      })
    }
    await expect(stat(join(root, 'bad'))).rejects.toMatchObject({ code: 'ENOENT' })
    const maximum = Buffer.alloc(MAX_TRANSFER_BYTES, 97)
    await api.files.upload({ root, path: 'maximum', base64: maximum.toString('base64') })
    expect((await api.files.download({ root, path: 'maximum' })).size).toBe(MAX_TRANSFER_BYTES)
  }, 15_000)

  test('bounds directory enumeration and marks partial listings', async () => {
    await Promise.all(
      Array.from({ length: MAX_FILE_ENTRIES + 1 }, (_, index) => mkdir(join(root, `dir-${index}`)))
    )
    const listing = await api.files.list({ root, path: '.' })
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(MAX_FILE_ENTRIES)
  }, 30_000)

  test('limits HTTP file bodies before decoding and remains available', async () => {
    const response = await fetch(server.url + '/files/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ root, path: 'oversize', base64: 'a'.repeat(8 * 1024 * 1024) })
    })
    expect(response.ok).toBe(false)
    await expect(stat(join(root, 'oversize'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await api.health.live()).toBe(true)
  }, 15_000)
})

describe('server-owned attachments', () => {
  test('uploads actual Mac image bytes, previews on owner, and feeds existing send-time validation', async () => {
    const macFile = join(other, 'Mac Screenshot.png')
    await writeFile(macFile, png)
    const source = await localAttachmentUpload({ path: macFile })
    expect(source).not.toHaveProperty('path')
    const file = await api.files.prepareAttachment({ sessionId: 'same-session', source })
    expect(file.path).toContain(join('attachments', 'same-session'))
    expect(file.path).not.toBe(macFile)
    expect(await readFile(file.path)).toEqual(png)
    await rm(macFile)
    expect((await preparePrompt('look', [file], true)).images[0]).toMatchObject({
      data: png.toString('base64'),
      mimeType: 'image/png'
    })
    expect(
      await api.files.previewAttachment({ sessionId: 'same-session', path: file.path })
    ).toEqual({ image: `data:image/png;base64,${png.toString('base64')}` })
    await expect(
      api2.files.previewAttachment({ sessionId: 'same-session', path: file.path })
    ).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(
      api.files.previewAttachment({ sessionId: 'another-session', path: file.path })
    ).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(preparePrompt('look', [file], false)).rejects.toThrow('Send as file reference')
    expect(
      (await preparePrompt('look', [{ ...file, delivery: 'reference' }], false)).text
    ).toContain(file.path)
  })

  test('validates magic for pasted and picked images; preserves explicit unsupported-image fallback', async () => {
    const file = await api.files.prepareAttachment({
      sessionId: 'session',
      source: { kind: 'upload', image: true, name: 'misnamed.jpg', base64: png.toString('base64') }
    })
    expect(file).toMatchObject({ name: 'misnamed.png', mimeType: 'image/png', delivery: 'image' })
    await expect(
      api.files.prepareAttachment({
        sessionId: 'session',
        source: {
          kind: 'upload',
          image: true,
          name: 'fake.png',
          base64: Buffer.from('not-image').toString('base64')
        }
      })
    ).rejects.toMatchObject({ code: 'invalid_data' })
    const picked = await api.files.prepareAttachment({
      sessionId: 'session',
      source: {
        kind: 'upload',
        image: false,
        name: 'fake.png',
        base64: Buffer.from('not-image').toString('base64')
      }
    })
    await expect(preparePrompt('', [picked], true)).rejects.toThrow('do not match')
    expect((await preparePrompt('', [{ ...picked, delivery: 'reference' }], true)).images).toEqual(
      []
    )
    const svg = await api.files.prepareAttachment({
      sessionId: 'session',
      source: {
        kind: 'upload',
        image: false,
        name: 'image.svg',
        base64: Buffer.from('<svg/>').toString('base64')
      }
    })
    expect(svg.delivery).toBe('image')
    await expect(preparePrompt('', [svg], true)).rejects.toThrow('cannot be sent directly')
    expect((await preparePrompt('', [{ ...svg, delivery: 'reference' }], true)).images).toEqual([])
  })

  test('copies transient remote references and bounds text/binary preview', async () => {
    await writeFile(join(root, 'notes.txt'), 'a'.repeat(20 * 1024))
    const file = await api.files.prepareAttachment({
      sessionId: 'session',
      source: { kind: 'file', root, path: 'notes.txt' }
    })
    await rm(join(root, 'notes.txt'))
    const preview = await api.files.previewAttachment({ sessionId: 'session', path: file.path })
    expect(preview.text?.length).toBe(16 * 1024)
    expect(preview.notice).toBe('Showing the first 16 KiB.')
    const binary = await api.files.prepareAttachment({
      sessionId: 'session',
      source: { kind: 'upload', name: 'binary.dat', image: false, base64: 'AA==' }
    })
    expect(await api.files.previewAttachment({ sessionId: 'session', path: binary.path })).toEqual({
      notice: 'Download the file to view its contents.'
    })
  })
})
