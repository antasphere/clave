import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  startEmbedded,
  type EmbeddedServer,
  WorkspaceFiles,
  memoryWorkspaceFilesStorage
} from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { ReviewNotFound } from '@clave/contract/workspace-files'
import { type ClaveApiClient, createApiClient } from './api'
import { PushClient } from './push-client'

let server: EmbeddedServer
let api: ClaveApiClient
let root: string

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'clave-wsf-client-')))
  server = await startEmbedded({
    ports: {
      sessions: new FakeSource(),
      workspaceFiles: new WorkspaceFiles(memoryWorkspaceFilesStorage())
    }
  })
  api = createApiClient({ url: server.url, token: server.token })
})
afterEach(async () => {
  await api.dispose()
  await server.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('the typed workspace files calls', () => {
  it('reads, writes, trusts and discovers', async () => {
    const file = join(root, 'a.clave')
    await api.workspaceFiles.write(
      file,
      {
        name: 'A',
        cwd: join(root, 'p'),
        color: 'teal',
        prompt: 'BRIEF',
        sessions: [],
        terminals: []
      },
      root
    )
    expect(await api.workspaceFiles.exists(file)).toBe(true)
    expect(await api.workspaceFiles.read(file, { rootDir: root })).toMatchObject({
      type: 'single',
      prompt: 'BRIEF',
      cwd: join(root, 'p')
    })
    await api.workspaceFiles.trustRoot(root)
    expect(await api.workspaceFiles.trustedRoots()).toEqual([root])
    await api.workspaceFiles.untrustRoot(root)
    expect(await api.workspaceFiles.trustedRoots()).toEqual([])
    expect(await api.workspaceFiles.discover(root)).toEqual([])
    expect(
      await api.workspaceFiles.discoverRecursive(root, { maxDepth: 2, exclude: ['x'] })
    ).toEqual([])
    expect(await api.workspaceFiles.autoDiscover(file)).toBeNull()
    expect(await api.workspaceFiles.image(join(root, 'none.png'))).toBeNull()
  })

  it('carries the requestId onto the review event and answers it', async () => {
    const file = join(root, 'e.clave')
    writeFileSync(
      file,
      JSON.stringify({ name: 'E', cwd: '.', prompt: 'P', sessions: [], terminals: [] })
    )
    const push = new PushClient({ url: server.url, token: server.token }).connect()
    try {
      await push.whenOpen()
      const seen = new Promise<{ reviewId: string; requestId: string | null }>((resolve) =>
        push.onEvent((envelope) => {
          if (envelope.event._tag === 'workspace_files.review_needed') resolve(envelope.event)
        })
      )
      const reading = api.workspaceFiles.read(file, { requestId: 'mine-1' })
      const review = await seen
      expect(review.requestId).toBe('mine-1')
      await api.workspaceFiles.answerReview(review.reviewId, {
        response: 0,
        checkboxChecked: false
      })
      const result = await reading
      expect(result).toMatchObject({ type: 'single', name: 'E' })
      expect((result as { prompt?: string }).prompt).toBeUndefined()
      const error = await api.workspaceFiles
        .answerReview(review.reviewId, { response: 0, checkboxChecked: false })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ReviewNotFound)
    } finally {
      push.close()
    }
  })
})
