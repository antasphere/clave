import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { expect, test } from 'vitest'
import { fileFixtureCatalog } from './files.fixtures'
import { FilesPort } from './port'
import { createServerFiles } from './service'
import { fileHandlers } from './handlers'
import { startEmbedded } from '../embedded'
import { createApiClient } from '../../../client/src/api'
import { preparePrompt } from '../../../../src/main/sessions/attachments'
import type { FileAttachment } from '@clave/contract/files'

test('loads remote-files/owned-content through commands and verifies the retained data over HTTP', async () => {
  const scratch = '/tmp/clave-vps-c-impl'
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'fixture-'))
  const files = createServerFiles({ attachmentsRoot: join(root, 'attachments'), roots: [root] })
  const layer = buses.pipe(
    Layer.provide(HandlerRegistry.layer(...fileHandlers)),
    Layer.provide(FilesPort.layer(files))
  )
  const server = await startEmbedded({ ports: { files } })
  const api = createApiClient({ url: server.url, token: server.token })
  try {
    const fixtures = await Effect.runPromise(
      fileFixtureCatalog.prepare('remote-files/owned-content', { root })
    )
    const report = await Effect.runPromise(
      (
        run({ fixtures, enabled: true, ready: () => Effect.void }) as Effect.Effect<
          RunReport<Readonly<Record<string, unknown>>>,
          FixtureError,
          CommandBus
        >
      ).pipe(Effect.provide(layer))
    )
    const value = report.values.content as {
      root: string
      path: string
      directory: string
      sessionId: string
      attachment: FileAttachment
    }
    expect(report.completed).toEqual(['remote-files/content'])
    expect((await api.files.read({ root, path: value.path })).content).toBe(
      'Editable on the owning server.'
    )
    await api.files.write({ root, path: value.path, content: 'Edited from an attached client.' })
    expect(await readFile(join(root, value.path), 'utf8')).toBe('Edited from an attached client.')
    expect((await preparePrompt('', [value.attachment], true)).images).toHaveLength(1)
    expect(
      (
        await api.files.previewAttachment({
          sessionId: value.sessionId,
          path: value.attachment.path
        })
      ).image
    ).toMatch(/^data:image\/png;base64,/)
    console.log(
      JSON.stringify({
        scenario: 'remote-files/owned-content',
        runId: report.runId,
        completed: report.completed,
        ids: report.ids,
        dataDirectory: root
      })
    )
    // Data remains for inspection unless this explicit cleanup switch is set.
    if (process.env.CLAVE_FILES_FIXTURES_CLEANUP === '1')
      await rm(root, { recursive: true, force: true })
  } finally {
    await api.dispose()
    await server.stop()
  }
}, 20_000)
