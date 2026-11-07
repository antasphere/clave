import { beforeAll } from 'vitest'
import { ensureFileHelper } from './test-support'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createServerFiles } from './service'
import { startEmbedded } from '../embedded'
import { createApiClient } from '../../../client/src/api'
import { preparePrompt } from '../../../../src/main/sessions/attachments'

const state = vi.hoisted(() => ({
  hook: undefined as undefined | ((path: string) => Promise<void>)
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      const value = await actual.realpath(path)
      if (state.hook) await state.hook(String(path))
      return value
    }
  }
})
const dirs: string[] = []
afterEach(async () => {
  state.hook = undefined
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})
async function setup(): Promise<{
  base: string
  root: string
  outside: string
  files: ReturnType<typeof createServerFiles>
}> {
  const scratch = '/tmp/clave-vps-c-impl/fix1'
  await fs.mkdir(scratch, { recursive: true })
  const base = await fs.mkdtemp(join(scratch, 'extra-'))
  dirs.push(base)
  const root = join(base, 'allowed')
  const outside = join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  const canonicalRoot = await fs.realpath(root)
  return {
    base,
    root: canonicalRoot,
    outside,
    files: createServerFiles({ roots: [root], attachmentsRoot: join(base, 'attachments') })
  }
}
for (const operation of ['read', 'write'] as const) {
  test(`containment remains enforced when a parent becomes a symlink after canonicalization: ${operation}`, async () => {
    const { root, outside, files } = await setup()
    await fs.mkdir(join(root, 'folder'))
    await fs.writeFile(join(root, 'folder', 'target'), 'inside')
    await fs.writeFile(join(outside, 'target'), 'outside-before')
    const path = join(root, 'folder', 'target')
    let swapped = false
    state.hook = async (resolved) => {
      if (resolved !== path) return
      state.hook = undefined
      await fs.rename(join(root, 'folder'), join(root, 'parked'))
      await fs.symlink(outside, join(root, 'folder'))
      swapped = true
    }
    const server = await startEmbedded({ ports: { files } })
    const api = createApiClient({ url: server.url, token: server.token })
    try {
      const result = await (
        operation === 'read'
          ? api.files.read({ root, path: 'folder/target' })
          : api.files.write({ root, path: 'folder/target', content: 'outside-overwritten' })
      ).then(
        (value) => ({ accepted: true, value }),
        (error) => ({ accepted: false, error: String(error) })
      )
      const disk = await fs.readFile(join(outside, 'target'), 'utf8')
      console.log(
        JSON.stringify({
          scenario: 'parent-symlink-race',
          operation,
          swapped,
          result,
          outsideDisk: disk
        })
      )
      expect(swapped).toBe(true)
      expect(result.accepted).toBe(false)
      expect(disk).toBe('outside-before')
    } finally {
      await api.dispose()
      await server.stop()
    }
  })
}
for (const operation of [
  'list',
  'stat',
  'download',
  'upload',
  'createFile',
  'createDirectory',
  'prepareAttachment',
  'previewAttachment'
] as const) {
  test(`parent replacement cannot escape through ${operation}`, async () => {
    const { root, outside, files } = await setup()
    await fs.mkdir(join(root, 'folder'))
    await fs.writeFile(join(root, 'folder', 'target.txt'), 'inside')
    await fs.writeFile(join(outside, 'target.txt'), 'outside-before')
    const creating = ['upload', 'createFile', 'createDirectory'].includes(operation)
    const relative = operation === 'list' ? 'folder' : `folder/${creating ? 'new' : 'target.txt'}`
    const barrier = join(root, creating || operation === 'list' ? 'folder' : relative)
    let swapped = false
    state.hook = async (path) => {
      if (path !== barrier) return
      state.hook = undefined
      await fs.rename(join(root, 'folder'), join(root, 'parked'))
      await fs.symlink(outside, join(root, 'folder'))
      swapped = true
    }
    const location = { root, path: relative }
    const perform = (): Promise<unknown> => {
      switch (operation) {
        case 'list':
          return files.list(location)
        case 'stat':
          return files.stat(location)
        case 'download':
          return files.download(location)
        case 'upload':
          return files.upload({ ...location, base64: 'YQ==' })
        case 'createFile':
          return files.createFile(location)
        case 'createDirectory':
          return files.createDirectory(location)
        case 'prepareAttachment':
          return files.prepareAttachment({
            sessionId: 'racing',
            source: { kind: 'file', ...location }
          })
        case 'previewAttachment':
          return files.previewAttachment({ sessionId: 'racing', ...location })
      }
    }
    const accepted = await perform().then(
      () => true,
      () => false
    )
    expect(swapped).toBe(true)
    expect(accepted).toBe(false)
    expect(await fs.readFile(join(outside, 'target.txt'), 'utf8')).toBe('outside-before')
    expect(await fs.readdir(outside)).toEqual(['target.txt'])
  })
}

test('managed attachment storage cannot be replaced by a link during initialization', async () => {
  const { base, root, outside } = await setup()
  const storage = join(base, 'managed')
  await fs.mkdir(storage)
  const canonicalStorage = await fs.realpath(storage)
  let swapped = false
  state.hook = async (path) => {
    if (path !== storage) return
    state.hook = undefined
    await fs.rename(storage, join(base, 'managed-original'))
    await fs.symlink(outside, storage)
    swapped = true
  }
  const files = createServerFiles({ roots: [root], attachmentsRoot: storage })
  const accepted = await files
    .prepareAttachment({
      sessionId: 'racing',
      source: { kind: 'upload', name: 'notes.txt', image: false, base64: 'YQ==' }
    })
    .then(
      () => true,
      () => false
    )
  expect(swapped).toBe(true)
  expect(accepted).toBe(false)
  expect(await fs.readdir(outside)).toEqual([])
  expect(canonicalStorage).toContain('/managed')
})

test('managed attachment preview rejects a session-parent replacement after canonicalization', async () => {
  const { base, files, outside } = await setup()
  const file = await files.prepareAttachment({
    sessionId: 'racing',
    source: { kind: 'upload', name: 'notes.txt', image: false, base64: 'YQ==' }
  })
  const directory = dirname(file.path)
  await fs.writeFile(join(outside, basename(file.path)), 'outside secret')
  let swapped = false
  state.hook = async (path) => {
    if (path !== file.path) return
    state.hook = undefined
    await fs.rename(directory, join(base, 'session-original'))
    await fs.symlink(outside, directory)
    swapped = true
  }
  await expect(
    files.previewAttachment({ sessionId: 'racing', path: file.path })
  ).rejects.toMatchObject({ code: 'invalid_path' })
  expect(swapped).toBe(true)
  expect(await fs.readFile(join(outside, basename(file.path)), 'utf8')).toBe('outside secret')
})

test('a configured root cannot be redirected by replacing it with an outside link', async () => {
  const { root, base, outside, files } = await setup()
  await fs.writeFile(join(outside, 'target'), 'outside secret')
  await files.stat({ root, path: '.' })
  await fs.rename(root, join(base, 'root-original'))
  await fs.symlink(outside, root)
  await expect(files.read({ root, path: 'target' })).rejects.toMatchObject({ code: 'invalid_path' })
})

test('replacing an ancestor above the configured root cannot escape its boundary', async () => {
  const { root, base, files } = await setup()
  const hostile = await fs.mkdtemp('/tmp/clave-vps-c-impl/fix1/ancestor-')
  dirs.push(hostile)
  await fs.mkdir(join(hostile, 'allowed'))
  await fs.writeFile(join(hostile, 'allowed', 'target'), 'outside secret')
  const target = join(root, 'target')
  await fs.writeFile(target, 'inside')
  const parked = `${base}-original`
  dirs.push(parked)
  let swapped = false
  state.hook = async (path) => {
    if (path !== target) return
    state.hook = undefined
    await fs.rename(base, parked)
    await fs.symlink(hostile, base)
    swapped = true
  }
  await expect(files.read({ root, path: 'target' })).rejects.toMatchObject({ code: 'invalid_path' })
  expect(swapped).toBe(true)
  expect(await fs.readFile(join(hostile, 'allowed', 'target'), 'utf8')).toBe('outside secret')
})

test('durable remote upload survives server/client restart and empty allowlist refuses file reads', async () => {
  const { root, base, files } = await setup()
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  let server = await startEmbedded({ ports: { files } })
  let api = createApiClient({ url: server.url, token: server.token })
  const file = await api.files.prepareAttachment({
    sessionId: 'collision',
    source: { kind: 'upload', name: 'same.png', image: true, base64: png.toString('base64') }
  })
  await api.dispose()
  await server.stop()
  server = await startEmbedded({
    ports: {
      files: createServerFiles({ roots: [root], attachmentsRoot: join(base, 'attachments') })
    }
  })
  api = createApiClient({ url: server.url, token: server.token })
  try {
    expect(await fs.readFile(file.path)).toEqual(png)
    expect(
      (await api.files.previewAttachment({ sessionId: 'collision', path: file.path })).image
    ).toBe('data:image/png;base64,' + png.toString('base64'))
    expect((await preparePrompt('', [file], true)).images[0].data).toBe(png.toString('base64'))
    await fs.writeFile(join(root, 'private'), 'hidden')
    const forbidden = createServerFiles({ roots: [], attachmentsRoot: join(base, 'no-access') })
    await expect(forbidden.read({ root, path: 'private' })).rejects.toMatchObject({
      code: 'invalid_path'
    })
  } finally {
    await api.dispose()
    await server.stop()
  }
})
test('attachment total cap rejects five valid 5 MiB images while exactly 20 MiB succeeds', async () => {
  const { root, files } = await setup()
  const bytes = Buffer.alloc(5 * 1024 * 1024)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes)
  await fs.writeFile(join(root, 'large.png'), bytes)
  const file = await files.prepareAttachment({
    sessionId: 'images',
    source: { kind: 'file', root, path: 'large.png' }
  })
  expect((await preparePrompt('', Array(4).fill(file), true)).images).toHaveLength(4)
  const overLimitAccepted = await preparePrompt('', Array(5).fill(file), true).then(
    () => true,
    (error) => {
      expect(String(error)).toContain('20 MiB')
      return false
    }
  )
  expect(overLimitAccepted).toBe(false)
})
test('persistent source references retain actual path and current contents with explicit root preview', async () => {
  const base = await fs.mkdtemp(join(process.cwd(), '.c-verify-persistent-'))
  dirs.push(base)
  const files = createServerFiles({ roots: [base], attachmentsRoot: join(base, 'attachments') })
  const path = join(base, 'notes.txt')
  await fs.writeFile(path, 'before')
  const file = await files.prepareAttachment({
    sessionId: 'durable',
    source: { kind: 'file', root: base, path: 'notes.txt' }
  })
  expect(file.path).toBe(path)
  await fs.writeFile(path, 'after')
  expect(
    await files.previewAttachment({ sessionId: 'durable', root: base, path: file.path })
  ).toEqual({ text: 'after' })
  await expect(
    files.previewAttachment({ sessionId: 'durable', path: file.path })
  ).rejects.toMatchObject({ code: 'invalid_path' })
  expect((await preparePrompt('', [file], false)).text).toContain(file.path)
})

test('a valid 255-character pasted image name returns a usable attachment without orphaning its bytes', async () => {
  const { files, base } = await setup()
  const server = await startEmbedded({ ports: { files } })
  const api = createApiClient({ url: server.url, token: server.token })
  try {
    const result = await api.files
      .prepareAttachment({
        sessionId: 'long-name',
        source: {
          kind: 'upload',
          name: 'x'.repeat(255),
          image: true,
          base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
        }
      })
      .then(
        (value) => ({ ok: true as const, nameLength: value.name.length }),
        (error) => ({ ok: false as const, error: String(error) })
      )
    const stored = await fs.readdir(join(base, 'attachments', 'long-name'))
    console.log(JSON.stringify({ scenario: 'long-image-name', result, storedCount: stored.length }))
    expect(result.ok).toBe(true)
    expect(stored).toHaveLength(1)
    if (result.ok) expect(result.nameLength).toBeLessThanOrEqual(255)
    expect(await fs.readFile(join(base, 'attachments', 'long-name', stored[0]))).toEqual(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      )
    )
  } finally {
    await api.dispose()
    await server.stop()
  }
})

beforeAll(ensureFileHelper, 30_000)

for (const name of ['x'.repeat(250) + '.jpeg', '😀'.repeat(125) + 'abcde']) {
  test(`normalizes maximum-length pasted names before persistence: ${name.slice(-8)}`, async () => {
    const { files, base } = await setup()
    const data = Buffer.from('89504e470d0a1a0a', 'hex')
    const result = await files.prepareAttachment({
      sessionId: 'names',
      source: { kind: 'upload', name, image: true, base64: data.toString('base64') }
    })
    expect(result.name.length).toBeLessThanOrEqual(255)
    expect(result.name.endsWith('.png')).toBe(true)
    expect(result.name).not.toMatch(/[\uD800-\uDBFF]\.png$/)
    expect(await fs.readdir(join(base, 'attachments', 'names'))).toHaveLength(1)
    expect(await fs.readFile(result.path)).toEqual(data)
  })
}
