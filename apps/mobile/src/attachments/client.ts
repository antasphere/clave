/**
 * The attachment client: the upload the desktop chat makes when a pasted
 * screenshot has no path (`POST /files/attachments/prepare` with an
 * `upload` source: the name, the bytes as base64, whether it is a picture;
 * `packages/contract/src/files.ts`, `PrepareFileAttachment`), answered by
 * the record the message then carries (`FileAttachment`: the id, the path
 * on the server where the bytes were written, the name, the type, the size,
 * the delivery). The server keeps the file under the session's own folder
 * and types it by name; a picture is checked by its first bytes there, and
 * only PNG, JPEG, GIF and WebP pass.
 *
 * Over lane C's `FetchLike`, with its credential shape, its reading of a 401
 * and a 422, and a deadline of a minute: five mebibytes over mobile data.
 */
import type { Credential, FetchLike } from '../api/client'
import { ServerError } from '../api/errors'
import { decodeServerFailure } from '../contract/decode'
import type { FileAttachment } from '../contract/types'
import { credentialMayTravelTo, type BuildKind } from '../machines/transport-policy'

export interface UploadSource {
  readonly name: string
  readonly base64: string
  /** The server checks the bytes as a picture and refuses what is not one. */
  readonly image: boolean
}

export interface AttachmentClientOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly build?: BuildKind
}

export const UPLOAD_TIMEOUT_MS = 60_000
export const PREPARE_PATH = '/files/attachments/prepare'

type Rec = Record<string, unknown>
const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const defaultFetch = (): FetchLike => {
  const f = (globalThis as { fetch?: unknown }).fetch
  if (typeof f !== 'function')
    throw new Error('No fetch in this environment: pass one in the options')
  return f as FetchLike
}

/** The record the server answered, by shape (lane C's mirror of the contract). */
export function decodeFileAttachment(value: unknown): FileAttachment {
  if (!isRecord(value)) throw new Error('not an attachment record')
  const str = (key: string): string => {
    const v = value[key]
    if (typeof v !== 'string' || !v) throw new Error(`attachment.${key}: expected a string`)
    return v
  }
  const delivery = value.delivery
  if (delivery !== 'image' && delivery !== 'reference' && delivery !== 'folder')
    throw new Error('attachment.delivery: expected image, reference or folder')
  const size = value.size
  if (typeof size !== 'number' || !Number.isFinite(size))
    throw new Error('attachment.size: expected a number')
  return {
    id: str('id'),
    path: str('path'),
    name: str('name'),
    mimeType: str('mimeType'),
    size,
    delivery,
    ...(typeof value.entries === 'number' ? { entries: value.entries } : {})
  }
}

export class AttachmentClient {
  readonly baseUrl: string
  private readonly fetch: FetchLike
  private readonly timeoutMs: number

  constructor(
    private readonly credential: Credential,
    options: AttachmentClientOptions = {}
  ) {
    this.baseUrl = credential.serverUrl.replace(/\/+$/, '')
    const verdict = credentialMayTravelTo(this.baseUrl, options.build ?? 'release')
    if (!verdict.ok) throw new ServerError('policy', verdict.reason)
    this.fetch = options.fetch ?? defaultFetch()
    this.timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS
  }

  /** Writes the bytes on the server under the session and answers the record. */
  async prepareUpload(sessionId: string, source: UploadSource): Promise<FileAttachment> {
    const body = JSON.stringify({
      sessionId,
      source: { kind: 'upload', name: source.name, base64: source.base64, image: source.image }
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let status: number
    let text: string
    try {
      const response = await this.fetch(`${this.baseUrl}${PREPARE_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credential.bearer}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body,
        signal: controller.signal
      })
      status = response.status
      text = await response.text()
    } catch (cause) {
      if (controller.signal.aborted)
        throw new ServerError(
          'timeout',
          `The upload did not finish within ${this.timeoutMs / 1000} s.`,
          {
            cause
          }
        )
      throw new ServerError('network', 'The server could not be reached.', { cause })
    } finally {
      clearTimeout(timer)
    }
    if (status === 401)
      throw new ServerError('unauthenticated', 'The server refused the token.', { status })
    let json: unknown = undefined
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        if (status >= 200 && status < 300)
          throw new ServerError('protocol', 'The server answered something unreadable.', { status })
      }
    }
    if (status === 422) {
      let failure
      try {
        failure = decodeServerFailure(json)
      } catch {
        throw new ServerError('protocol', 'The server refused (422) without a readable reason.', {
          status
        })
      }
      throw new ServerError('refused', failure.message, { status, failure })
    }
    if (status === 413)
      throw new ServerError('refused', 'The file is larger than the server takes in one upload.', {
        status
      })
    if (status < 200 || status >= 300)
      throw new ServerError('protocol', `The server answered ${status}.`, { status })
    try {
      return decodeFileAttachment(json)
    } catch (cause) {
      throw new ServerError(
        'protocol',
        `The server's answer to ${PREPARE_PATH} does not have the expected shape: ${cause instanceof Error ? cause.message : String(cause)}`,
        { status, cause }
      )
    }
  }
}
