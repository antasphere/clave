import fs from 'fs'
import { DigestStore } from './exchange-digest-store'
import { settingsPorts } from './ports'
import { TEST_NO_ACTIVATE } from './test-mode'
import { accountTokenForSpawn } from './sessions/adapters/pty-backend'
import * as helperRunner from './helpers/runner'
import { helperAccountId } from './helpers/runner'
import { helperConfig } from './helpers/registry'
import { DIGEST_TIMEOUT_MS, exchangeDigestHelper, workDigestHelper } from './helpers/digests'
import type { HelperFailureReason } from '../shared/helper-prompt'
import {
  clipDigestMessages,
  digestKey,
  parseDigestReply,
  type DigestDone,
  type DigestLaunch,
  type DigestMessage,
  type DigestRequest,
  type DigestResult
} from '../shared/exchange-digest'
import {
  clipNotes,
  parseWorkDigestReply,
  placeNote,
  workDigestBucket,
  workDigestKey,
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
  if (!request.messages.length)
    return Promise.resolve({ ok: false, error: 'No messages', reason: 'refused' })
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
  if (!request.notes.length)
    return Promise.resolve({ ok: false, error: 'No notes', reason: 'refused' })
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
    journalRead('exchange', request.sessionId, request.key)
    const reply = testReply(process.env.CLAVE_E2E_DIGEST_REPLY, request.launch)
    if (!reply) return Promise.resolve({ ok: false, error: 'No model under test' })
    return testAccount(exchangeDigestHelper, request.launch).then(
      (refused) =>
        refused ??
        new Promise<DigestResult>((resolve) =>
          setTimeout(
            () =>
              resolve(
                testFailure(reply) ??
                  parseDigestReply(reply, request.messages.length) ?? {
                    ok: false,
                    error: 'Unreadable test reply'
                  }
              ),
            600
          )
        )
    )
  }
  const { messages, offset } = clipDigestMessages(request.messages)
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
    journalRead('work', request.sessionId, request.key)
    const reply = testReply(process.env.CLAVE_E2E_WORK_DIGEST_REPLY, request.launch)
    if (!reply) return Promise.resolve({ ok: false, error: 'No model under test' })
    return testAccount(workDigestHelper, request.launch).then(
      (refused) =>
        refused ??
        new Promise<WorkDigestResult>((resolve) =>
          setTimeout(
            () =>
              resolve(
                testFailure(reply) ??
                  parseWorkDigestReply(reply, request.notes.length) ?? {
                    ok: false,
                    error: 'Unreadable test reply'
                  }
              ),
            600
          )
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

/** Under the harness, every read is journaled where THIS process keeps its
 *  data (main: the app's user data; a separate server: `userData/server`;
 *  a daemon: its data dir), one JSON line each, so a spec tells which
 *  process read a digest (`chat-digest-early.spec.mjs`). */
function journalRead(kind: 'exchange' | 'work', sessionId: string, key: string): void {
  try {
    fs.appendFileSync(
      settingsPorts().storage.pathOf('e2e-digest-reads.jsonl'),
      `${JSON.stringify({ kind, sessionId, key, pid: process.pid, at: Date.now() })}\n`
    )
  } catch {
    /* a journal that cannot be written is no read of its own */
  }
}

/** The harness's reply, with `{account}` standing for the account the read
 *  runs on (`default` for the machine login), so a spec sees which one. */
function testReply(reply: string | undefined, launch: DigestLaunch): string | undefined {
  return reply?.replaceAll('{account}', launch.claudeProfileId ?? 'default')
}

/** Under the harness, a read stands in for the run up to the model call:
 *  the helper's own config (`helperConfig`, the seam the Settings page sets)
 *  decides whether it runs and on which account (`helperAccountId`), and that
 *  account resolves as a spawn resolves it (`accountTokenForSpawn`): a helper
 *  switched off answers `disabled`, an account this process does not know
 *  fails as the CLI would be refused, `auth`. */
async function testAccount(
  definition: Parameters<typeof helperConfig>[0],
  launch: DigestLaunch
): Promise<{ ok: false; error: string; reason: 'auth' | 'disabled' } | null> {
  const config = helperConfig(definition)
  if (!config.enabled)
    return { ok: false, error: `${definition.label} is switched off`, reason: 'disabled' }
  try {
    await accountTokenForSpawn('claude', helperAccountId(config, launch))
    return null
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      reason: 'auth'
    }
  }
}

/** `E2E_FAIL:<reason>` under the harness: a read that fails with that reason. */
function testFailure(
  reply: string
): { ok: false; error: string; reason: HelperFailureReason } | null {
  const match = /^E2E_FAIL:(\w+)$/.exec(reply.trim())
  return match
    ? { ok: false, error: 'A failure under test', reason: match[1] as HelperFailureReason }
    : null
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
export interface HostDigestRequest {
  sessionId: string
  key: string
  messages: readonly DigestMessage[]
}
export interface HostWorkDigestRequest {
  sessionId: string
  key: string
  notes: readonly string[]
  tools: number
}

export interface HostDigests {
  exchangeDigest: (request: HostDigestRequest) => Promise<DigestResult>
  exchangeDigestsOf: (sessionId: string) => Record<string, DigestDone>
  workDigest: (request: HostWorkDigestRequest) => Promise<WorkDigestResult>
  workDigestsOf: (sessionId: string) => Record<string, WorkDigestDone>
}

/** A session this host has no record of: said, never read on a guess. */
export const UNKNOWN_SESSION_ERROR = 'This server has no record of that session'

/** The digests as a host serves them to its clients. */
/** Where a host's sessions are known: its records, and the launch of what it
 *  spawned (the session manager, `pty-manager.ts`). */
export interface DigestLaunchSource {
  getSessionRecord: (sessionId: string) => DigestLaunchRecord | null | undefined
  spawnLaunchOf: (sessionId: string) => DigestLaunchRecord | null | undefined
}

/** The launch a host reads a session's digests on, as both servers compose
 *  it: its own RECORD of the session first (what a tab comes back on, and
 *  what an account switch rewrites), else the launch of the process it
 *  spawned (a session that keeps no record), else none: refused. */
export function sessionLaunchOf(source: DigestLaunchSource): DigestRecordOf {
  return (sessionId) => source.getSessionRecord(sessionId) ?? source.spawnLaunchOf(sessionId)
}

/** How many reads a session may have waiting on the host at once: a client
 *  asking for more is told to ask again in a moment, so no client can queue
 *  model calls without end, nor push a tab's real digests out of its store. */
export const MAX_WAITING_PER_SESSION = 10

/** A key that is not the key of what it came with: a call would cost a model
 *  read for content the store files under a name it does not have. */
export const KEY_MISMATCH_ERROR = 'The key does not match what was sent'

/** The digests as a host serves them to its clients. Every request is read
 *  on the launch of the host's own record of the session, under the key the
 *  host recomputes from the content (a key that does not match is refused),
 *  and at most MAX_WAITING_PER_SESSION distinct reads wait per session. */
export function hostDigests(recordOf: DigestRecordOf): HostDigests {
  const launchOf = (sessionId: string): DigestLaunch | null => {
    const record = recordOf(sessionId)
    return record ? launchFromRecord(record) : null
  }
  const waiting = new Map<string, Set<string>>()
  /** Run a read, unless it is one more than the session may have waiting.
   *  A read filed already, or one already waiting, costs nothing more. */
  const admit = <R>(
    sessionId: string,
    id: string,
    filed: boolean,
    run: () => Promise<R>,
    busy: R
  ): Promise<R> => {
    if (filed) return run()
    const pending = waiting.get(sessionId) ?? new Set<string>()
    if (!pending.has(id) && pending.size >= MAX_WAITING_PER_SESSION) return Promise.resolve(busy)
    pending.add(id)
    waiting.set(sessionId, pending)
    return run().finally(() => {
      pending.delete(id)
      if (pending.size === 0 && waiting.get(sessionId) === pending) waiting.delete(sessionId)
    })
  }
  const unknown = {
    ok: false as const,
    error: UNKNOWN_SESSION_ERROR,
    reason: 'unknown-session' as const
  }
  const mismatch = { ok: false as const, error: KEY_MISMATCH_ERROR, reason: 'refused' as const }
  const busy = {
    ok: false as const,
    error: 'Too many reads are waiting for this tab',
    reason: 'busy' as const
  }
  return {
    exchangeDigest: (request) => {
      // Clipped as the view clips (idempotent), so the key is the view's.
      const { messages } = clipDigestMessages(request.messages)
      if (digestKey(messages) !== request.key) return Promise.resolve(mismatch)
      const launch = launchOf(request.sessionId)
      if (!launch) return Promise.resolve(unknown)
      return admit<DigestResult>(
        request.sessionId,
        request.key,
        digests().get(request.sessionId, request.key) !== undefined,
        () => requestDigest({ sessionId: request.sessionId, key: request.key, messages, launch }),
        busy
      )
    },
    exchangeDigestsOf: digestsOf,
    workDigest: (request) => {
      const { notes } = clipNotes(request.notes)
      if (workDigestKey(notes) !== request.key) return Promise.resolve(mismatch)
      const launch = launchOf(request.sessionId)
      if (!launch) return Promise.resolve(unknown)
      return admit<WorkDigestResult>(
        request.sessionId,
        request.key,
        digests().get(workDigestBucket(request.sessionId), request.key) !== undefined,
        () =>
          requestWorkDigest({
            sessionId: request.sessionId,
            key: request.key,
            notes,
            tools: request.tools,
            launch
          }),
        busy
      )
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
