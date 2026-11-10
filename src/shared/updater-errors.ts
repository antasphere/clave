/**
 * What the updater tells a user when a check or a download fails.
 *
 * electron-updater surfaces its errors verbatim, and the verbatim form of an
 * HTTP failure is the whole exchange: status line, method and URL, the HTML
 * body GitHub served, and every response header as JSON. On 8 November 2026 a
 * GitHub 504 on `latest-mac.yml` reached the Software Update pane as fourteen
 * lines of that, headers included, under "Could not check for updates". The
 * reader had to know what a Gateway Time-out is, that the URL names GitHub's
 * release server and not ours, and that nothing on their side was wrong.
 *
 * So the raw message is read once, here, into two lines: a sentence that
 * says what happened and what, if anything, to do, and one technical line
 * (status, method, URL) for the reader who wants it. The full text stays in
 * the updater log, which the pane already opens.
 *
 * Pure and shared: main decides the wording so every window agrees, and the
 * renderer only displays. No dependency, so the table of status names is ours.
 */

import type { UpdateChannel } from './updater-types'

export type UpdaterErrorKind = 'check' | 'download'

/**
 * Where the failure sits between this Mac and the release, which is what the
 * pane's drawing shows: the far side not answering, the near side offline, the
 * release missing its file, a refusal in between, or this Mac itself (a full
 * disk, a damaged download). `unknown` when the message names none of them.
 */
export type UpdaterErrorCause = 'server' | 'network' | 'manifest' | 'refused' | 'local' | 'unknown'

export interface UpdaterErrorDescription {
  /** Where it broke, for the drawing. */
  cause: UpdaterErrorCause
  /** One or two plain sentences: what happened, and what to do, if anything. */
  summary: string
  /**
   * One technical line — `504 Gateway Timeout · GET https://…/latest-mac.yml`,
   * or the error's first line when there is no HTTP status to name. Null when
   * the summary already says everything the raw message said.
   */
  detail: string | null
}

const STATUS_TEXT = new Map<number, string>([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [408, 'Request Timeout'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
  [504, 'Gateway Timeout']
])

const CHECK_AGAIN = 'Clave checks again on its own within 30 minutes, or press Check for Updates.'
const INSTALL_BY_HAND = 'You can also install the release by hand from GitHub.'

/** The messages a dropped or absent network produces, in Node and in Chromium. */
const OFFLINE =
  /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED|socket hang up|network error/i

/** Where the exchange was headed, when the message carries it. */
function urlOf(raw: string): string | null {
  const explicit = /\burl:\s*(https?:\/\/\S+)/.exec(raw)
  if (explicit) return explicit[1].replace(/["',)\]]+$/, '')
  const any = /(https?:\/\/[^\s"'()<>]+)/.exec(raw)
  return any ? any[1] : null
}

/**
 * The HTTP status, in any of the three shapes builder-util-runtime writes:
 * `504 Gateway Time-out …` (the status line; the reason phrase is empty over
 * HTTP/2, so `504 "method: …` is the common form), `HTTP error: Gateway
 * timeout`-style messages built from the code alone, and the `HTTP_ERROR_504`
 * code a wrapping error quotes.
 */
function statusOf(raw: string): number | null {
  const lead = /^\s*(\d{3})\b/.exec(raw)
  if (lead) return Number(lead[1])
  const coded = /HTTP_ERROR_(\d{3})/.exec(raw)
  if (coded) return Number(coded[1])
  const phrased = /HTTP error:\s*(\d{3})/.exec(raw)
  if (phrased) return Number(phrased[1])
  // A wrapped HttpError, as in electron-updater's missing-manifest message.
  const wrapped = /HttpError:\s*(\d{3})\b/.exec(raw)
  if (wrapped) return Number(wrapped[1])
  return null
}

function firstLine(raw: string): string {
  const line = raw.split('\n').find((l) => l.trim().length > 0) ?? ''
  const trimmed = line.trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed
}

function hostOf(url: string | null): string {
  if (!url) return 'GitHub'
  try {
    const host = new URL(url).hostname
    return /github/i.test(host) ? 'GitHub' : host
  } catch {
    return 'GitHub'
  }
}

/**
 * Read a raw updater error into the two lines the UI shows. `kind` picks the
 * closing advice: a failed check costs nothing and retries itself, a failed
 * download has the manual route.
 */
export function describeUpdaterError(
  raw: string | null | undefined,
  context: { kind: UpdaterErrorKind; channel?: UpdateChannel }
): UpdaterErrorDescription {
  const text = (raw ?? '').trim()
  const { kind } = context
  const channel = context.channel ?? 'stable'
  const url = urlOf(text)
  const host = hostOf(url)
  const status = statusOf(text)
  const tail = kind === 'check' ? CHECK_AGAIN : INSTALL_BY_HAND

  if (text.length === 0) {
    return {
      cause: 'unknown',
      summary:
        kind === 'check'
          ? `The check did not complete, and the updater gave no reason. ${CHECK_AGAIN}`
          : `The download did not complete, and the updater gave no reason. ${INSTALL_BY_HAND}`,
      detail: null
    }
  }

  // A release whose manifest is missing: the asset was not uploaded, or the
  // release is still being assembled. electron-updater names the file.
  if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|Cannot find .*\.yml/i.test(text) || status === 404) {
    const where = channel === 'beta' ? 'latest pre-release' : 'latest release'
    return {
      cause: 'manifest',
      summary: `The ${where} on GitHub has no update manifest yet. A release is usually complete a few minutes after it appears; if this stays, the release is incomplete and we need to know. ${tail}`,
      detail: detailLine(status, url, text)
    }
  }

  if (
    /ERR_UPDATER_ZIP_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|No published versions/i.test(
      text
    )
  ) {
    return {
      cause: 'manifest',
      summary: `GitHub lists no release the updater can read for the ${channel} channel. ${tail}`,
      detail: detailLine(status, url, text)
    }
  }

  if (status !== null && (status >= 500 || status === 408)) {
    return {
      cause: 'server',
      summary: `${host} did not answer in time. The failure is on ${host}'s side and usually passes within minutes; nothing on this Mac is wrong. ${tail}`,
      detail: detailLine(status, url, text)
    }
  }

  if (status === 429) {
    return {
      cause: 'refused',
      summary: `${host} is rate-limiting update requests from this network for a while. ${tail}`,
      detail: detailLine(status, url, text)
    }
  }

  if (status === 401 || status === 403) {
    return {
      cause: 'refused',
      summary: `${host} refused the request. A proxy, a VPN or a network filter between this Mac and ${host} is the usual cause. ${tail}`,
      detail: detailLine(status, url, text)
    }
  }

  if (status !== null) {
    return {
      cause: 'unknown',
      summary: `${host} answered with an error (${status}${STATUS_TEXT.has(status) ? ` ${STATUS_TEXT.get(status)}` : ''}). ${tail}`,
      detail: detailLine(status, url, text)
    }
  }

  if (OFFLINE.test(text)) {
    return {
      cause: 'network',
      summary: `Clave could not reach ${host}. Check that this Mac is online and that nothing blocks github.com. ${tail}`,
      detail: firstLine(text)
    }
  }

  if (/ENOSPC|no space left/i.test(text)) {
    return {
      cause: 'local',
      summary: `There is no room left on the disk for the update. Free some space, then try again.`,
      detail: firstLine(text)
    }
  }

  if (/signature|code sign|codesign|not signed|checksum|sha512/i.test(text)) {
    return {
      cause: 'local',
      summary: `The downloaded update did not pass its integrity check and was discarded. A fresh download usually fixes it. ${INSTALL_BY_HAND}`,
      detail: firstLine(text)
    }
  }

  // Unknown: say that honestly, and give the one line the log would open on.
  return {
    cause: 'unknown',
    summary:
      kind === 'check'
        ? `The check failed for a reason the updater did not classify. ${CHECK_AGAIN}`
        : `The download failed for a reason the updater did not classify. ${INSTALL_BY_HAND}`,
    detail: firstLine(text)
  }
}

function detailLine(status: number | null, url: string | null, text: string): string {
  if (status === null) return firstLine(text)
  const name = STATUS_TEXT.get(status)
  const head = name ? `${status} ${name}` : String(status)
  return url ? `${head} · GET ${url}` : head
}
