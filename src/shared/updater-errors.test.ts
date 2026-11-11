import { describe, it, expect } from 'vitest'
import { describeUpdaterError } from './updater-errors'

/**
 * The message GitHub's release edge produced on 8 November 2026, as
 * builder-util-runtime wrote it: an empty reason phrase (HTTP/2), the request
 * description as a JSON string, the HTML body, and every header. This is what
 * the Software Update pane showed, verbatim, under "Could not check for updates".
 */
const GITHUB_504 = `504 "method: GET url: https://github.com/antasphere/clave/releases/download/v3.0.0-beta.18/latest-mac.yml

 Data:
 <html><body><h1>504 Gateway Time-out</h1>
The server didn't respond in time.
</body></html>

 "
Headers: {
  "cache-control": "no-cache",
  "content-length": "92",
  "content-type": "text/html",
  "date": "Sun, 08 Nov 2026 10:09:36 GMT",
  "x-github-edge-region": "switzerlandnorth",
  "x-github-request-id": "668A:30160F:510246:DB090D:6AF04A49"
}`

describe('describeUpdaterError', () => {
  it('turns a GitHub 504 into a sentence that blames the right side, and one technical line', () => {
    const d = describeUpdaterError(GITHUB_504, { kind: 'check', channel: 'beta' })
    expect(d.cause).toBe('server')
    expect(d.summary).toMatch(/GitHub did not answer in time/)
    expect(d.summary).toMatch(/nothing on this Mac is wrong/)
    expect(d.summary).toMatch(/Check for Updates/)
    expect(d.detail).toBe(
      '504 Gateway Timeout · GET https://github.com/antasphere/clave/releases/download/v3.0.0-beta.18/latest-mac.yml'
    )
    // The headers and the HTML body never reach the pane.
    expect(d.summary + d.detail).not.toMatch(/Headers|x-github|<html>/)
  })

  it('reads the status from the HTTP error code when the status line is absent', () => {
    const d = describeUpdaterError('HttpError: HTTP error: Gateway timeout (HTTP_ERROR_502)', {
      kind: 'check'
    })
    expect(d.summary).toMatch(/GitHub did not answer in time/)
    expect(d.detail).toBe('502 Bad Gateway')
  })

  it('names the missing manifest when the channel file is not on the release', () => {
    const raw =
      'Error: Cannot find beta-mac.yml in the latest release artifacts (https://github.com/antasphere/clave/releases/download/v3.0.0-beta.19/beta-mac.yml): HttpError: 404 Not Found'
    const d = describeUpdaterError(raw, { kind: 'check', channel: 'beta' })
    expect(d.cause).toBe('manifest')
    expect(d.summary).toMatch(/latest pre-release on GitHub has no update manifest yet/)
    expect(d.detail).toBe(
      '404 Not Found · GET https://github.com/antasphere/clave/releases/download/v3.0.0-beta.19/beta-mac.yml'
    )
  })

  it('reads a 404 status line as the same missing-manifest case on the stable channel', () => {
    const d = describeUpdaterError('404 "method: GET url: https://github.com/x/y/latest-mac.yml"', {
      kind: 'check',
      channel: 'stable'
    })
    expect(d.summary).toMatch(/latest release on GitHub has no update manifest yet/)
  })

  it('tells an offline Mac it is offline, for Node and Chromium spellings alike', () => {
    for (const raw of [
      'Error: getaddrinfo ENOTFOUND github.com',
      'net::ERR_INTERNET_DISCONNECTED',
      'Error: connect ECONNREFUSED 140.82.121.3:443'
    ]) {
      const d = describeUpdaterError(raw, { kind: 'check' })
      expect(d.cause).toBe('network')
      expect(d.summary).toMatch(/could not reach GitHub/)
      expect(d.detail).toBe(raw)
    }
  })

  it('gives a failed download the manual route instead of the check-again advice', () => {
    const d = describeUpdaterError('net::ERR_FAILED', { kind: 'download' })
    expect(d.summary).toMatch(/by hand from GitHub/)
    expect(d.summary).not.toMatch(/Check for Updates/)
  })

  it('treats a 403 as something between the Mac and GitHub, not as GitHub being down', () => {
    const d = describeUpdaterError(
      '403 Forbidden\n"method: GET url: https://objects.githubusercontent.com/a"',
      {
        kind: 'download'
      }
    )
    expect(d.cause).toBe('refused')
    expect(d.summary).toMatch(/refused the request/)
    expect(d.summary).toMatch(/proxy/)
    expect(d.detail).toBe('403 Forbidden · GET https://objects.githubusercontent.com/a')
  })

  it('reports an integrity failure as discarded, never as a reason to keep the file', () => {
    const d = describeUpdaterError('Error: sha512 checksum mismatch, expected abc, got def', {
      kind: 'download'
    })
    expect(d.cause).toBe('local')
    expect(d.summary).toMatch(/integrity check/)
  })

  it('says so when it cannot classify, and keeps only the first line as detail', () => {
    const d = describeUpdaterError('Something odd happened\nwith a second line\nand a third', {
      kind: 'check'
    })
    expect(d.summary).toMatch(/did not classify/)
    expect(d.detail).toBe('Something odd happened')
  })

  it('caps an unclassified first line so a stack trace cannot flood the pane', () => {
    const d = describeUpdaterError('x'.repeat(600), { kind: 'check' })
    expect(d.detail?.length).toBe(200)
    expect(d.detail?.endsWith('…')).toBe(true)
  })

  it('has words for an empty message', () => {
    const d = describeUpdaterError('', { kind: 'check' })
    expect(d.summary).toMatch(/gave no reason/)
    expect(d.detail).toBeNull()
  })
})
