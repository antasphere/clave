import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ServerError } from '../api/errors'
import type { FileAttachment } from '../contract/types'
import { AttachmentClient } from './client'
import { buildUserMessage, prepareAttachment } from './compose'
import { pickDocuments, pickPhotos, takePhoto } from './pickers'
import { admit, type AdmissionContext } from './policy'
import { MAX_ATTACHMENTS, MAX_TRANSFER_BYTES, type PickedFile } from './types'

const file: PickedFile = {
  uri: 'file:///photo.png',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 3,
  kind: 'image'
}
const context: AdmissionContext = {
  count: 0,
  imageBytes: 0,
  imagesSupported: true,
  filesRoute: true
}
const record: FileAttachment = {
  id: 'f-1',
  path: '/tmp/session/attachments/photo.png',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 3,
  delivery: 'image'
}

describe('attachment admission and picker translation', () => {
  it('admits images within the provider and transfer limits', () => {
    expect(admit(file, context)).toEqual({ ok: true, image: true })
    expect(admit({ ...file, size: MAX_TRANSFER_BYTES }, context).ok).toBe(true)
  })
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TRANSFER_BYTES + 1, null])(
    'refuses an invalid or oversized size %s',
    (size) => {
      expect(admit({ ...file, size }, context).ok).toBe(false)
    }
  )
  it('refuses excess records and total image bytes', () => {
    expect(admit(file, { ...context, count: MAX_ATTACHMENTS }).ok).toBe(false)
    expect(admit(file, { ...context, imageBytes: 20 * 1024 * 1024 }).ok).toBe(false)
  })
  it('a missing files route refuses explicitly', () => {
    expect(admit(file, { ...context, filesRoute: false })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('cannot take files')
    })
  })
  it('HEIC, video, and a provider without images receive a file and an explanation', () => {
    for (const f of [
      { ...file, mimeType: 'image/heic' },
      { ...file, mimeType: 'video/mp4', kind: 'video' as const }
    ])
      expect(admit(f, context)).toMatchObject({ ok: true, image: false, note: expect.any(String) })
    expect(admit(file, { ...context, imagesSupported: false })).toMatchObject({
      ok: true,
      image: false,
      note: expect.any(String)
    })
  })
  it('photo library, camera and document picker pass platform options and cancellation', async () => {
    expect(
      await pickPhotos(
        {
          launchImageLibraryAsync: async (options) => {
            expect(options.selectionLimit).toBe(3)
            return {
              canceled: false,
              assets: [{ uri: file.uri, width: 1, height: 1, fileName: file.name, fileSize: 3 }]
            }
          }
        },
        3
      )
    ).toEqual([file])
    expect(await takePhoto({ launchCameraAsync: async () => ({ canceled: true }) })).toBeNull()
    expect(
      await pickDocuments(
        {
          getDocumentAsync: async (options) => {
            expect(options.copyToCacheDirectory).toBe(true)
            return {
              canceled: false,
              assets: [{ uri: 'file:///notes.txt', name: 'notes.txt', size: 12 }]
            }
          }
        },
        1
      )
    ).toMatchObject([{ name: 'notes.txt', mimeType: 'text/plain', kind: 'file' }])
  })
})

describe('prepare and compose', () => {
  it('uploads bytes and labels the returned record, preserving the message ID', async () => {
    const result = await prepareAttachment(
      file,
      's-1',
      [],
      {
        reader: { readBase64: async () => 'YWJj' },
        client: {
          prepareUpload: async (id, source) => {
            expect(id).toBe('s-1')
            expect(source).toEqual({ name: 'photo.png', base64: 'YWJj', image: true })
            return record
          }
        }
      },
      context
    )
    expect(result).toMatchObject({ ok: true, record: { label: 'Image #1' } })
    if (!result.ok) throw new Error(result.reason)
    const message = buildUserMessage('Look', [result.record], 'message-1234')
    expect(message).toEqual({
      type: 'user_message',
      text: 'Look [Image #1]',
      attachments: [result.record],
      clientMessageId: 'message-1234'
    })
    expect(buildUserMessage('Look [Image #1]', [result.record]).text).toBe('Look [Image #1]')
  })
  it('checks actual bytes before upload, even if the picker understated the size', async () => {
    let uploaded = false
    const result = await prepareAttachment(
      file,
      's-1',
      [],
      {
        reader: { readBase64: async () => 'A'.repeat(4 * Math.ceil((MAX_TRANSFER_BYTES + 3) / 3)) },
        client: {
          prepareUpload: async () => {
            uploaded = true
            return record
          }
        }
      },
      context
    )
    expect(result.ok).toBe(false)
    expect(uploaded).toBe(false)
  })
  it('numbers per kind without reusing removed labels and surfaces a refused upload', async () => {
    const result = await prepareAttachment(
      file,
      's-1',
      [{ ...record, label: 'Image #4' }],
      {
        reader: { readBase64: async () => 'YWJj' },
        client: { prepareUpload: async () => record }
      },
      context
    )
    expect(result).toMatchObject({ ok: true, record: { label: 'Image #5' } })
    const refused = await prepareAttachment(
      file,
      's-1',
      [],
      {
        reader: { readBase64: async () => 'YWJj' },
        client: {
          prepareUpload: async () => {
            throw new ServerError('refused', 'Upload unavailable')
          }
        }
      },
      context
    )
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Upload unavailable')
    })
  })
})

let server: Server
let url: string
let received:
  | { authorization: string | undefined; path: string | undefined; body: unknown }
  | undefined
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      received = { authorization: req.headers.authorization, path: req.url, body: JSON.parse(raw) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(record))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('No port')
  url = `http://127.0.0.1:${addr.port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
it('uploads through the desktop files route with the device credential, using a local stub', async () => {
  const client = new AttachmentClient(
    { serverUrl: url, bearer: 'fixture-device-session' },
    { build: 'development' }
  )
  expect(
    await client.prepareUpload('s-1', { name: 'photo.png', base64: 'YWJj', image: true })
  ).toEqual(record)
  expect(received).toEqual({
    authorization: 'Bearer fixture-device-session',
    path: '/files/attachments/prepare',
    body: {
      sessionId: 's-1',
      source: { kind: 'upload', name: 'photo.png', base64: 'YWJj', image: true }
    }
  })
})
it('a release upload refuses plain HTTP before sending a credential', () => {
  expect(() => new AttachmentClient({ serverUrl: url, bearer: 'fixture-device-session' })).toThrow(
    ServerError
  )
})
