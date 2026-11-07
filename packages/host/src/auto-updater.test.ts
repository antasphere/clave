import { describe, it, expect } from 'vitest'
import {
  availableStatePatch,
  channelFor,
  downloadStrategy,
  updaterFlags,
  normalizeReleaseBody,
  normalizeReleaseNotes,
  phaseOnAvailable,
  phaseOnCheckError,
  phaseOnCheckStart,
  phaseOnNotAvailable,
  type UpdatePhase
} from './auto-updater'

/**
 * The one rule worth pinning: a retry must not be the same request that just
 * failed. It used to be — `handleRetry` called `startDownload()`, which called
 * `autoUpdater.downloadUpdate()`, with nothing in between changing state or
 * strategy. A deterministic failure was therefore unescapable, and because
 * auto-update is Clave's whole distribution channel, a user who hit one stayed
 * on their version indefinitely without knowing.
 *
 * Only `downloadStrategy` is exercised here. `startDownload` reaches into the
 * electron-updater singleton and `initAutoUpdater` early-returns unless the app
 * is packaged, so neither can be decided without a window — that belongs to the
 * end-to-end specs, per this suite's pure-logic rule.
 */
describe('downloadStrategy', () => {
  it('lets the first attempt take the fast differential path', () => {
    expect(downloadStrategy('first')).toEqual({ disableDifferentialDownload: false })
  })

  it('drops differential on a retry, so the request differs from the one that failed', () => {
    expect(downloadStrategy('retry')).toEqual({ disableDifferentialDownload: true })
  })

  it('never returns the same strategy for both attempts', () => {
    // The regression guard proper: whatever the strategy grows into, a retry
    // that resolves to the first attempt's plan is the bug this fixed.
    expect(downloadStrategy('retry')).not.toEqual(downloadStrategy('first'))
  })
})

/**
 * The transitions. Each case here is a way the updater UI used to lie: a
 * background check every 30 minutes runs underneath whatever the user is
 * doing, so a handler that just assigns a phase will stomp a download in
 * flight, and a check that could not reach GitHub will either say nothing at
 * all or raise a full-screen "Update failed" over an app that is fine.
 */
describe('phase transitions', () => {
  it('enters checking only from rest', () => {
    expect(phaseOnCheckStart('idle')).toBe('checking')
    expect(phaseOnCheckStart('available')).toBe('checking')
  })

  it('never repaints work in flight as checking', () => {
    expect(phaseOnCheckStart('downloading')).toBe('downloading')
    expect(phaseOnCheckStart('downloaded')).toBe('downloaded')
    expect(phaseOnCheckStart('error')).toBe('error')
  })

  it('surfaces an available update from rest', () => {
    expect(phaseOnAvailable('idle', false)).toBe('available')
    expect(phaseOnAvailable('checking', false)).toBe('available')
  })

  it('does not demote a download in flight when the timer re-finds the update', () => {
    // The 30-minute check re-emits update-available for the version already
    // downloading. Assigning 'available' here would replace the progress
    // overlay with a Download button mid-transfer.
    expect(phaseOnAvailable('downloading', true)).toBe('downloading')
    expect(phaseOnAvailable('downloaded', false)).toBe('downloaded')
    expect(phaseOnAvailable('error', false)).toBe('error')
  })

  it('returns to rest when the server has nothing, without touching a download', () => {
    expect(phaseOnNotAvailable('checking')).toBe('idle')
    expect(phaseOnNotAvailable('available')).toBe('idle')
    expect(phaseOnNotAvailable('downloading')).toBe('downloading')
    expect(phaseOnNotAvailable('downloaded')).toBe('downloaded')
  })

  it('never turns a failed check into a failed update', () => {
    // `error` is the full-screen overlay. A check that could not reach GitHub
    // must land in checkErrorMessage and stay out of this phase entirely.
    const every: UpdatePhase[] = ['idle', 'checking', 'available', 'downloading', 'downloaded']
    for (const phase of every) {
      expect(phaseOnCheckError(phase)).not.toBe('error')
    }
    expect(phaseOnCheckError('checking')).toBe('idle')
    expect(phaseOnCheckError('downloading')).toBe('downloading')
  })
})

/**
 * The release notes behind the update banner's disclosure.
 *
 * This is the ONE thing that can tell a user what an update contains before
 * they take it: `help/whats-new.json` is stamped and bundled at build time, so
 * the note for a version lives only inside that version's own binary. The
 * running app therefore has exactly one source, the GitHub release bodies that
 * arrive on `update-available`.
 *
 * Every case below is a shape the provider actually produces, and all of them
 * fail identically if mishandled — a chevron that opens onto nothing, which
 * reads as a broken control rather than as an absent changelog. Hence the
 * invariant this suite exists to hold: **the result is null or it is useful.**
 * Never an empty array, never an entry with a blank body.
 */
describe('normalizeReleaseNotes', () => {
  it('wraps the single-string form, naming it with the version it came for', () => {
    expect(normalizeReleaseNotes('### Fixed\n- A thing', '1.80.0')).toEqual([
      { version: '1.80.0', note: '### Fixed\n- A thing', format: 'markdown' }
    ])
  })

  it('keeps every release in the fullChangelog array, in the order given', () => {
    const raw = [
      { version: '1.80.0', note: 'newest' },
      { version: '1.79.0', note: 'older' }
    ]
    expect(normalizeReleaseNotes(raw, '1.80.0')).toEqual([
      { version: '1.80.0', note: 'newest', format: 'markdown' },
      { version: '1.79.0', note: 'older', format: 'markdown' }
    ])
  })

  it('returns null when there are no notes at all', () => {
    expect(normalizeReleaseNotes(null, '1.80.0')).toBeNull()
  })

  // A release published with an empty body is the common real case, and the
  // one that produced a disclosure opening onto blank space.
  it('returns null rather than an empty array when every body is blank', () => {
    expect(normalizeReleaseNotes([{ version: '1.80.0', note: '' }], '1.80.0')).toBeNull()
    expect(normalizeReleaseNotes([{ version: '1.80.0', note: '   \n ' }], '1.80.0')).toBeNull()
    expect(normalizeReleaseNotes('', '1.80.0')).toBeNull()
    expect(normalizeReleaseNotes('  \n\t ', '1.80.0')).toBeNull()
  })

  it('drops the blank releases and keeps the rest', () => {
    const raw = [
      { version: '1.80.0', note: '' },
      { version: '1.79.0', note: 'real notes' }
    ]
    expect(normalizeReleaseNotes(raw, '1.80.0')).toEqual([
      { version: '1.79.0', note: 'real notes', format: 'markdown' }
    ])
  })

  it('falls back to the available version when an entry carries none', () => {
    expect(normalizeReleaseNotes([{ note: 'body' }], '1.80.0')).toEqual([
      { version: '1.80.0', note: 'body', format: 'markdown' }
    ])
  })

  it('trims the bodies it keeps', () => {
    expect(normalizeReleaseNotes('  body  ', '1.80.0')).toEqual([
      { version: '1.80.0', note: 'body', format: 'markdown' }
    ])
  })

  it('survives an entry the provider left null', () => {
    const raw = [null, { version: '1.79.0', note: 'kept' }] as unknown as Array<{
      version?: string
      note?: string | null
    }>
    expect(normalizeReleaseNotes(raw, '1.80.0')).toEqual([
      { version: '1.79.0', note: 'kept', format: 'markdown' }
    ])
  })
})

/**
 * The format fork, and the bug it exists for.
 *
 * GitHub's releases FEED — the one `electron-updater` reads bodies from — hands
 * back each body already rendered to HTML, not the Markdown it was authored in.
 * Fed to a Markdown renderer that escapes what it cannot parse, that reached
 * the update card as `<h3>Added</h3> <ul> <li>…` in plain, visible text: every
 * tag on screen, nothing formatted, and no error anywhere. So the body is
 * sniffed, sanitised, and labelled here, and the renderer trusts the label.
 *
 * The sanitising half is a real boundary, not a formality: the renderer sets
 * this string as markup. What is asserted below is the allowlist doing its job
 * on the two things that actually arrive in a GitHub body — the wrapper markup
 * around the note, and anything carrying script.
 */
describe('normalizeReleaseBody', () => {
  it('leaves a Markdown body alone and names it Markdown', () => {
    expect(normalizeReleaseBody('### Added\n- **A thing** — with a dash.')).toEqual({
      note: '### Added\n- **A thing** — with a dash.',
      format: 'markdown'
    })
  })

  // The exact shape the user saw as text in the card.
  it("recognises the feed's rendered HTML and keeps its structure", () => {
    const body = normalizeReleaseBody(
      '<h3>Added</h3> <ul> <li><strong>Edit beside your agent</strong> — a linked file.</li> </ul>'
    )
    expect(body?.format).toBe('html')
    expect(body?.note).toContain('<h3>Added</h3>')
    expect(body?.note).toContain('<strong>Edit beside your agent</strong>')
  })

  // `<` on its own is not HTML: a Markdown note may name a key chord or a
  // generic type, and mislabelling it would strip the note to its text.
  it('does not mistake angle brackets in prose for markup', () => {
    expect(normalizeReleaseBody('Press <Cmd+K> to open the launcher.')?.format).toBe('markdown')
    expect(normalizeReleaseBody('- Accepts a `Map<string, Session>` now.')?.format).toBe('markdown')
  })

  it('drops script, styles and images while keeping the words around them', () => {
    const body = normalizeReleaseBody(
      '<div class="markdown-body"><p>Real note.<script>steal()</script></p>' +
        '<p><img src="https://example.test/shot.png" alt="shot"> After.</p></div>'
    )
    expect(body?.format).toBe('html')
    expect(body?.note).toContain('Real note.')
    expect(body?.note).toContain('After.')
    expect(body?.note).not.toContain('steal()')
    expect(body?.note).not.toContain('<script')
    expect(body?.note).not.toContain('<img')
    // The wrapper GitHub puts round every body loses its box, not its content.
    expect(body?.note).not.toContain('<div')
  })

  it('strips event handlers and javascript: links from an anchor it keeps', () => {
    const body = normalizeReleaseBody(
      '<p><a href="javascript:alert(1)" onclick="alert(1)">click</a> and ' +
        '<a href="https://example.test/pr/1">a real link</a></p>'
    )
    expect(body?.note).not.toContain('javascript:')
    expect(body?.note).not.toContain('onclick')
    expect(body?.note).toContain('https://example.test/pr/1')
    // Opened in the browser, never in the renderer.
    expect(body?.note).toContain('target="_blank"')
    expect(body?.note).toContain('rel="noopener noreferrer"')
  })

  // Same invariant as the notes list: null, or something worth opening.
  it('returns null for a body that sanitises down to no words', () => {
    expect(normalizeReleaseBody('<div><img src="x.png"></div>')).toBeNull()
    expect(normalizeReleaseBody('<p>  </p>')).toBeNull()
    expect(normalizeReleaseBody('')).toBeNull()
    expect(normalizeReleaseBody(null)).toBeNull()
  })

  it('carries the format through the notes list, per entry', () => {
    const raw = [
      { version: '1.80.0', note: '<p>rendered</p>' },
      { version: '1.79.0', note: '### raw' }
    ]
    expect(normalizeReleaseNotes(raw, '1.80.0')).toEqual([
      { version: '1.80.0', note: '<p>rendered</p>', format: 'html' },
      { version: '1.79.0', note: '### raw', format: 'markdown' }
    ])
  })
})

/**
 * The carry-through: provider notes → updater state.
 *
 * `normalizeReleaseNotes` being correct proves nothing on its own if the
 * `update-available` handler never calls it. That handler is unreachable from a
 * test — `initAutoUpdater` early-returns unless the app is packaged — so the
 * patch it builds is a function of its own, and this is the check that the
 * notes actually make the trip. Deleted, the banner shows no disclosure ever,
 * which looks exactly like a release published without notes.
 */
describe('availableStatePatch', () => {
  it('carries the release notes into the state', () => {
    const patch = availableStatePatch(
      { version: '1.80.0', releaseNotes: '### Added\n- A thing' },
      1000
    )
    expect(patch.releaseNotes).toEqual([
      { version: '1.80.0', note: '### Added\n- A thing', format: 'markdown' }
    ])
  })

  it('carries every release of a fullChangelog answer, in order', () => {
    const patch = availableStatePatch(
      {
        version: '1.80.0',
        releaseNotes: [
          { version: '1.80.0', note: 'newest' },
          { version: '1.79.0', note: 'older' }
        ]
      },
      1000
    )
    expect(patch.releaseNotes?.map((n) => n.version)).toEqual(['1.80.0', '1.79.0'])
  })

  // The format travels with the notes or the renderer has to guess again.
  it("carries the format the provider's body turned out to be", () => {
    const patch = availableStatePatch(
      { version: '1.80.0', releaseNotes: '<h3>Added</h3><ul><li>A thing</li></ul>' },
      1000
    )
    expect(patch.releaseNotes?.[0].format).toBe('html')
  })

  it('names the version and stamps the check', () => {
    const patch = availableStatePatch({ version: '1.80.0', releaseNotes: 'body' }, 4242)
    expect(patch.availableVersion).toBe('1.80.0')
    expect(patch.lastCheckedAt).toBe(4242)
  })

  it('clears a stale check error, since the check just succeeded', () => {
    expect(availableStatePatch({ version: '1.80.0' }, 1000).checkErrorMessage).toBeNull()
  })

  it('leaves the notes null when the provider sent none', () => {
    expect(availableStatePatch({ version: '1.80.0' }, 1000).releaseNotes).toBeNull()
    expect(
      availableStatePatch({ version: '1.80.0', releaseNotes: null }, 1000).releaseNotes
    ).toBeNull()
  })
})

/**
 * The channel, as electron-updater sees it. Two guarantees matter and both
 * fail silently if broken: a stable install offered a beta (a user who never
 * asked gets unfinished software), and a beta user who leaves the channel and
 * is never offered the stable release (stuck on a beta with no way back).
 */
describe('updaterFlags', () => {
  it('stable channel on a stable build: neither flag', () => {
    expect(updaterFlags(false, '1.92.0')).toEqual({ allowPrerelease: false, allowDowngrade: false })
  })

  it('beta channel on a stable build: pre-releases allowed, no downgrade', () => {
    expect(updaterFlags(true, '1.92.0')).toEqual({ allowPrerelease: true, allowDowngrade: false })
  })

  it('leaving the channel on a beta build allows the downgrade to the current stable', () => {
    expect(updaterFlags(false, '2.0.0-beta.1')).toEqual({
      allowPrerelease: false,
      allowDowngrade: true
    })
  })

  it('staying on the channel on a beta build never downgrades', () => {
    expect(updaterFlags(true, '2.0.0-beta.1')).toEqual({
      allowPrerelease: true,
      allowDowngrade: false
    })
  })

  it('the toggle IS allowPrerelease, whatever the running version', () => {
    for (const v of ['1.92.0', '2.0.0-beta.1', '2.0.0-alpha.3']) {
      expect(updaterFlags(true, v).allowPrerelease).toBe(true)
      expect(updaterFlags(false, v).allowPrerelease).toBe(false)
    }
  })
})

describe('channelFor', () => {
  it('names the channel after the toggle', () => {
    expect(channelFor(false)).toBe('stable')
    expect(channelFor(true)).toBe('beta')
  })
})

describe('availableStatePatch — pre-release flag', () => {
  it('marks a beta on offer as one, so the prompt can say so', () => {
    expect(availableStatePatch({ version: '2.0.0-beta.1' }, 1).availableIsPrerelease).toBe(true)
  })

  it('does not mark a stable version', () => {
    expect(availableStatePatch({ version: '1.92.0' }, 1).availableIsPrerelease).toBe(false)
  })
})
