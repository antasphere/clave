import { DigestStore } from './exchange-digest-store'
import { settingsPorts } from './ports'
import { TEST_NO_ACTIVATE } from './test-mode'
import * as helperRunner from './helpers/runner'
import { helperCliArgs } from './helpers/runner'
import { DIGEST_TIMEOUT_MS, exchangeDigestHelper, workDigestHelper } from './helpers/digests'
import {
  parseDigestReply,
  type DigestDone,
  type DigestRequest,
  type DigestResult
} from '../shared/exchange-digest'
import {
  clipNotes,
  parseWorkDigestReply,
  placeNote,
  workDigestBucket,
  type WorkDigestDone,
  type WorkDigestRequest,
  type WorkDigestResult
} from '../shared/work-digest'

/**
 * The exchange digest (`src/shared/exchange-digest.ts` says what it is for)
 * and the WORK digest (`src/shared/work-digest.ts`, the title of a card of
 * the agent's working notes, PRDCT-4212): two helpers (`helpers/digests.ts`)
 * run by the helpers' runner, on the agent and the account the session runs,
 * their answers filed by session so a timeline reads them once. The queue,
 * the cap and the kill on quit are the runner's (PRDCT-3375).
 */

export { DIGEST_TIMEOUT_MS }

/** The CLI arguments a digest is asked with on the helper's defaults. */
export const DIGEST_CLI_ARGS = helperCliArgs(
  exchangeDigestHelper.systemPrompt,
  exchangeDigestHelper
)

/** The digest of a timeline never needs more than its latest messages. */
const MAX_MESSAGES = 30
/** Nor more than this of any one message. */
const MAX_CHARS = 4000

const clip = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text

/** The digests read so far, filed by session (exchange-digest-store.ts),
 *  in Clave's data folder through the storage port rather than Electron's
 *  `app`: this module is loaded by the session manager, which the standalone
 *  server runs under Bun, where an import of Electron ends the process before
 *  it announces itself. Inside the app the port is Electron's own data folder,
 *  so the file is where it was. */
let store: DigestStore | null = null
const digests = (): DigestStore =>
  (store ??= new DigestStore(settingsPorts().storage.pathOf('exchange-digests.json')))

/** The same messages asked for twice at once (both views of a tab, a remount)
 *  share one call. */
const inflight = new Map<string, Promise<DigestResult>>()

/** Every exchange digest read for a tab: what its timelines show on opening. */
export function digestsOf(sessionId: string): Record<string, DigestDone> {
  return digests().of(sessionId)
}

/** Every work digest read for a tab (its own bucket, `workDigestBucket`):
 *  what its cards are titled on opening. */
export function workDigestsOf(sessionId: string): Record<string, WorkDigestDone> {
  return digests().of(workDigestBucket(sessionId)) as unknown as Record<string, WorkDigestDone>
}

/** A timeline's digest: the one filed for these messages, or a call read now
 *  and filed when it answers. */
export function requestDigest(request: DigestRequest): Promise<DigestResult> {
  if (helperRunner.isShutDown())
    return Promise.resolve({ ok: false, error: 'Clave is quitting', reason: 'cancelled' })
  if (!request.messages.length) return Promise.resolve({ ok: false, error: 'No messages' })
  const filed = digests().get(request.sessionId, request.key)
  if (filed) return Promise.resolve(filed)
  const id = `${request.sessionId}|${request.key}`
  const running = inflight.get(id)
  if (running) return running
  const ask = read(request).then((result) => {
    inflight.delete(id)
    if (result.ok) digests().put(request.sessionId, request.key, result)
    return result
  })
  inflight.set(id, ask)
  return ask
}

/** The digest of a stretch of working notes: the one filed for these notes,
 *  or a call read now and filed when it answers (`work-digest.ts`). */
export function requestWorkDigest(request: WorkDigestRequest): Promise<WorkDigestResult> {
  if (helperRunner.isShutDown())
    return Promise.resolve({ ok: false, error: 'Clave is quitting', reason: 'cancelled' })
  if (!request.notes.length) return Promise.resolve({ ok: false, error: 'No notes' })
  const bucket = workDigestBucket(request.sessionId)
  const filed = digests().get(bucket, request.key) as unknown as WorkDigestDone | undefined
  if (filed) return Promise.resolve(filed)
  const id = `${bucket}|${request.key}`
  const running = workInflight.get(id)
  if (running) return running
  const ask = readWork(request).then((result) => {
    workInflight.delete(id)
    if (result.ok) digests().put(bucket, request.key, result as unknown as DigestDone)
    return result
  })
  workInflight.set(id, ask)
  return ask
}
const workInflight = new Map<string, Promise<WorkDigestResult>>()

function read(request: DigestRequest): Promise<DigestResult> {
  // Under the end-to-end harness no model is called: a spec that wants a
  // digest hands the model's reply in CLAVE_E2E_DIGEST_REPLY, read the way a
  // real one is, after a beat so the reading state shows.
  if (TEST_NO_ACTIVATE) {
    const reply = process.env.CLAVE_E2E_DIGEST_REPLY
    if (!reply) return Promise.resolve({ ok: false, error: 'No model under test' })
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            parseDigestReply(reply, request.messages.length) ?? {
              ok: false,
              error: 'Unreadable test reply'
            }
          ),
        600
      )
    )
  }
  const messages = request.messages.slice(-MAX_MESSAGES).map((message) => ({
    from: message.from,
    text: clip(message.text) ?? '',
    request: clip(message.request),
    reply: clip(message.reply)
  }))
  const offset = request.messages.length - messages.length
  return helperRunner
    .runHelper(exchangeDigestHelper, messages, request.launch)
    .then((outcome): DigestResult => {
      if (!outcome.ok) {
        if (outcome.reason === 'unreadable')
          console.warn('[exchange-digest] unreadable reply:', outcome.detail.slice(0, 200))
        return { ok: false, error: failureText(outcome), reason: outcome.reason }
      }
      const parsed = outcome.value
      return { ...parsed, message: parsed.message === null ? null : parsed.message + offset }
    })
}

function readWork(request: WorkDigestRequest): Promise<WorkDigestResult> {
  // Under the harness, the reply comes from CLAVE_E2E_WORK_DIGEST_REPLY.
  if (TEST_NO_ACTIVATE) {
    const reply = process.env.CLAVE_E2E_WORK_DIGEST_REPLY
    if (!reply) return Promise.resolve({ ok: false, error: 'No model under test' })
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            parseWorkDigestReply(reply, request.notes.length) ?? {
              ok: false,
              error: 'Unreadable test reply'
            }
          ),
        600
      )
    )
  }
  const { notes, offset } = clipNotes(request.notes)
  return helperRunner
    .runHelper(workDigestHelper, { notes, tools: request.tools }, request.launch)
    .then((outcome): WorkDigestResult => {
      if (!outcome.ok) {
        if (outcome.reason === 'unreadable')
          console.warn('[exchange-digest] unreadable work reply:', outcome.detail.slice(0, 200))
        return { ok: false, error: failureText(outcome), reason: outcome.reason }
      }
      return placeNote(outcome.value, offset)
    })
}

/** What a failed digest says: the asked-shape one in words, the rest as the CLI said it. */
function failureText(outcome: { reason: string; detail: string }): string {
  return outcome.reason === 'unreadable'
    ? 'The model did not answer in the asked shape'
    : outcome.detail
}

/* The host's side (PRDCT-4327): a client asks the server a tab runs on for
 * its digests, and the server reads them on the tab's own agent and account,
 * which it takes from ITS OWN record of the session. What a client sends
 * about the launch is never read: a server's account ids mean nothing on the
 * Mac that shows the tab, and the reverse. The digests are filed in the
 * host's data folder, so every client of that server reads the same one. */

/** The fields of a session record a digest's launch is read from. */
export interface DigestLaunchRecord {
  workspaceId?: string
  launchProfileId?: string
  claudeProfileId?: string
  configDir?: string
}

/** How the host finds its own record of a session, by the session's id. */
export type DigestRecordOf = (sessionId: string) => DigestLaunchRecord | null | undefined

/** The launch a digest runs on: the record's, field for field. No account on
 *  the record is the Default (the machine login), never another account. */
export function launchFromRecord(record: DigestLaunchRecord): DigestLaunch {
  return {
    workspaceId: record.workspaceId,
    launchProfileId: record.launchProfileId,
    claudeProfileId: record.claudeProfileId,
    configDir: record.configDir
  }
}

/** What a client sends: the digest's subject, never its launch. */
export type HostDigestRequest = Omit<DigestRequest, 'launch'>
export type HostWorkDigestRequest = Omit<WorkDigestRequest, 'launch'>

export interface HostDigests {
  exchangeDigest: (request: HostDigestRequest) => Promise<DigestResult>
  exchangeDigestsOf: (sessionId: string) => Record<string, DigestDone>
  workDigest: (request: HostWorkDigestRequest) => Promise<WorkDigestResult>
  workDigestsOf: (sessionId: string) => Record<string, WorkDigestDone>
}

/** A session this host has no record of: said, never read on a guess. */
export const UNKNOWN_SESSION_ERROR = 'This server has no record of that session'

/** The digests as a host serves them to its clients. */
export function hostDigests(recordOf: DigestRecordOf): HostDigests {
  const launchOf = (sessionId: string): DigestLaunch | null => {
    const record = recordOf(sessionId)
    return record ? launchFromRecord(record) : null
  }
  return {
    exchangeDigest: (request) => {
      const launch = launchOf(request.sessionId)
      if (!launch)
        return Promise.resolve({ ok: false, error: UNKNOWN_SESSION_ERROR, reason: 'failed' })
      return requestDigest({
        sessionId: request.sessionId,
        key: request.key,
        messages: request.messages,
        launch
      })
    },
    exchangeDigestsOf: digestsOf,
    workDigest: (request) => {
      const launch = launchOf(request.sessionId)
      if (!launch)
        return Promise.resolve({ ok: false, error: UNKNOWN_SESSION_ERROR, reason: 'failed' })
      return requestWorkDigest({
        sessionId: request.sessionId,
        key: request.key,
        notes: request.notes,
        tools: request.tools,
        launch
      })
    },
    workDigestsOf
  }
}

/** End every queued and running digest: the sessions' shutdown calls it with
 *  the titles' (`pty-manager.ts` killAll); `quit` also shuts the door. The
 *  runner is one for every helper, so this ends the titles' too. */
export function cancelAll(quit = false): void {
  store?.flush()
  if (quit) helperRunner.shutdown()
  else helperRunner.cancelAll()
}
