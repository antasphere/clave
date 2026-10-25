import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { FILE_TREE_IGNORED, MAX_FILE_ENTRIES } from '@clave/contract/files'
import { createServerFiles } from './service'
import { ensureFileHelper } from './test-support'
import { startEmbedded } from '../embedded'
import { createApiClient } from '../../../client/src/api'

let root: string
beforeAll(ensureFileHelper, 30_000)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clave-list-all-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const files = (): ReturnType<typeof createServerFiles> =>
  createServerFiles({ attachmentsRoot: join(root, 'attachments'), roots: [root] })
it('lists sorted relative files, skips ignored names at depth, dotfiles and symlink folders', async () => {
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'z.ts'), '')
  await writeFile(join(root, 'a.ts'), '')
  await writeFile(join(root, '.env'), '')
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, '.hidden', 'no'), '')
  for (const name of FILE_TREE_IGNORED) {
    await mkdir(join(root, 'src', name))
    await writeFile(join(root, 'src', name, 'no'), '')
  }
  await symlink(join(root, 'src'), join(root, 'linked-folder'))
  await symlink(join(root, 'a.ts'), join(root, 'linked-file'))
  expect(await files().listAll({ root })).toEqual({
    files: ['a.ts', 'linked-file', 'src/z.ts'],
    truncated: false
  })
  await expect(files().listAll({ root: tmpdir() })).rejects.toMatchObject({
    _tag: 'FileOperationFailed',
    code: 'invalid_path'
  })
})
it('caps results and marks them truncated through the HTTP client', async () => {
  await Promise.all(
    Array.from({ length: MAX_FILE_ENTRIES + 1 }, (_, i) => writeFile(join(root, `f-${i}`), ''))
  )
  const server = await startEmbedded({ ports: { files: files() } })
  const api = createApiClient({ url: server.url, token: server.token })
  try {
    const response = await fetch(server.url + '/files/list-all', {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ root })
    })
    expect(response.status).toBe(200)
    expect((await response.json()).files).toHaveLength(MAX_FILE_ENTRIES)
    const result = await api.files.listAll({ root })
    expect(result.files).toHaveLength(MAX_FILE_ENTRIES)
    expect(result.truncated).toBe(true)
    expect(result.files).toEqual([...result.files].sort())
  } finally {
    await api.dispose()
    await server.stop()
  }
}, 30_000)
it('reports both capabilities as unavailable without a files port', async () => {
  const server = await startEmbedded({ ports: {} })
  const api = createApiClient({ url: server.url, token: server.token })
  try {
    await expect(api.files.listAll({ root })).rejects.toMatchObject({
      _tag: 'CapabilityUnavailable'
    })
    await expect(
      api.files.syncWatch({ namespace: 'one', generation: 0, tree: null })
    ).rejects.toMatchObject({ _tag: 'CapabilityUnavailable' })
  } finally {
    await api.dispose()
    await server.stop()
  }
})

it('skips an unreadable subfolder but refuses an unreadable root', async () => {
  const blocked = join(root, 'blocked')
  await mkdir(blocked)
  await writeFile(join(blocked, 'hidden.txt'), 'unreadable')
  await writeFile(join(root, 'visible.txt'), 'visible')
  await chmod(blocked, 0)
  try {
    expect(await files().listAll({ root })).toEqual({ files: ['visible.txt'], truncated: false })
  } finally {
    await chmod(blocked, 0o700)
  }
  await chmod(root, 0)
  try {
    await expect(files().listAll({ root })).rejects.toMatchObject({ _tag: 'FileOperationFailed' })
  } finally {
    await chmod(root, 0o700)
  }
})
