import { DigestStore } from './exchange-digest-store'
import { settingsPorts } from './ports'
import { TEST_NO_ACTIVATE } from './test-mode'
import * as helperRunner from './helpers/runner'
import { resolveHelperConfig } from './helpers/registry'
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

// ── PRDCT-4330 (helpers-settings lane) ──
/** Whether the harness's canned reply stands in for the model. A spec that
 *  puts a stub `claude` on the PATH sets CLAVE_E2E_DIGEST_RUNNER=1 to send the
 *  digests through the runner, so their arguments can be read. */
const harnessReplies = (): boolean =>
  TEST_NO_ACTIVATE && process.env.CLAVE_E2E_DIGEST_RUNNER !== '1'

/** A helper that is off never reaches the harness's reply either: the
 *  preference is read first, as the runner reads it. */
async function switchedOff(
  helper: typeof exchangeDigestHelper | typeof workDigestHelper
): Promise<{ ok: false; error: string; reason: 'disabled' } | null> {
  const config = await resolveHelperConfig(helper)
  return config.enabled
    ? null
    : {
        ok: false,
        error: `Switched off in Settings › Helpers (${helper.label}).`,
        reason: 'disabled'
      }
}
// ── end PRDCT-4330 ──

async function read(request: DigestRequest): Promise<DigestResult> {
  // Under the end-to-end harness no model is called: a spec that wants a
  // digest hands the model's reply in CLAVE_E2E_DIGEST_REPLY, read the way a
  // real one is, after a beat so the reading state shows.
  if (harnessReplies()) {
    const off = await switchedOff(exchangeDigestHelper)
    if (off) return off
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

async function readWork(request: WorkDigestRequest): Promise<WorkDigestResult> {
  // Under the harness, the reply comes from CLAVE_E2E_WORK_DIGEST_REPLY.
  if (harnessReplies()) {
    const off = await switchedOff(workDigestHelper)
    if (off) return off
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

/** End every queued and running digest: the sessions' shutdown calls it with
 *  the titles' (`pty-manager.ts` killAll); `quit` also shuts the door. The
 *  runner is one for every helper, so this ends the titles' too. */
export function cancelAll(quit = false): void {
  store?.flush()
  if (quit) helperRunner.shutdown()
  else helperRunner.cancelAll()
}
