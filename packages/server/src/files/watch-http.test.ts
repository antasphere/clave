import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { beforeAll, expect, it } from 'vitest'
import { startEmbedded } from '../embedded'
import { createApiClient } from '../../../client/src/api'
import { PushClient, type PushSocketConstructor } from '../../../client/src/push-client'
import { FileTreeWatcher } from './watch'
import { createServerFiles } from './service'
import { ensureFileHelper } from './test-support'
import type { ServerEvent } from '@clave/contract/events'

beforeAll(ensureFileHelper, 30_000)
it('serves a whole watch over HTTP and publishes real disk changes over push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clave-watch-http-'))
  const watcher = new FileTreeWatcher()
  const server = await startEmbedded({
    ports: {
      files: createServerFiles({
        attachmentsRoot: join(root, 'attachments'),
        roots: [root],
        watcher
      })
    }
  })
  const api = createApiClient({ url: server.url, token: server.token })
  const push = new PushClient({
    url: server.url,
    token: server.token,
    WebSocket: WebSocket as unknown as PushSocketConstructor
  }).connect()
  try {
    await push.whenOpen()
    let receive!: (event: ServerEvent) => void
    const changed = new Promise<ServerEvent>((resolve) => {
      receive = resolve
    })
    push.onEvent(({ event }) => {
      if (event._tag === 'files.dirs_changed') receive(event)
    })
    expect(
      await api.files.syncWatch({
        namespace: 'http-window',
        generation: 1,
        tree: { root, dirs: [] }
      })
    ).toEqual({ watched: ['.'] })
    await writeFile(join(root, 'created.txt'), 'changed')
    expect(await changed).toEqual({
      _tag: 'files.dirs_changed',
      namespace: 'http-window',
      root,
      dirs: ['.']
    })
    expect(
      await api.files.syncWatch({ namespace: 'http-window', generation: 2, tree: null })
    ).toEqual({ watched: [] })
  } finally {
    push.close()
    await api.dispose()
    await server.stop()
    await rm(root, { recursive: true, force: true })
  }
})
