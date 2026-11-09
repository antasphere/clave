import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { limitReportOf, providerEventReportsLimit } from './limit-report'

/**
 * The CLI's own word on its account's limit, and WHICH cap it hit (ADR 0002,
 * PRDCT-4302): what turns a chat stream frame into a proposal or a switch,
 * and which rung comes first. A frame read as a limit that is not one moves a
 * tab for nothing; one missed leaves the user to find out at the next turn;
 * a family cap read as the account's sends the tab off a subscription it
 * could still use.
 */
const rejected = (info: Record<string, unknown>): unknown => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', ...info }
})
const synthetic = (text: string, model = '<synthetic>'): unknown => ({
  type: 'assistant',
  message: { model, role: 'assistant', content: [{ type: 'text', text }] }
})

describe('limitReportOf, Claude', () => {
  it('reads the rejected rate-limit event, and nothing else of the event kind', () => {
    expect(limitReportOf('claude', rejected({ resetsAt: 1 }))).toEqual({
      scope: 'unknown',
      resetsAt: 1000
    })
    expect(
      limitReportOf('claude', {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day' }
      })
    ).toBeNull()
    expect(limitReportOf('claude', { type: 'system', subtype: 'init' })).toBeNull()
  })

  it("names the scope from the event's type: the shared caps, or a family's week", () => {
    expect(limitReportOf('claude', rejected({ rateLimitType: 'five_hour' }))).toEqual({
      scope: 'shared'
    })
    expect(limitReportOf('claude', rejected({ rateLimitType: 'seven_day' }))).toEqual({
      scope: 'shared'
    })
    expect(
      limitReportOf('claude', rejected({ rateLimitType: 'seven_day_overage_included' }))
    ).toEqual({ scope: 'shared' })
    expect(limitReportOf('claude', rejected({ rateLimitType: 'seven_day_opus' }))).toEqual({
      scope: { family: 'Opus' }
    })
    expect(limitReportOf('claude', rejected({ rateLimitType: 'seven_day_sonnet' }))).toEqual({
      scope: { family: 'Sonnet' }
    })
    // The service's own code for the Fable week, as the usage read maps it.
    expect(limitReportOf('claude', rejected({ rateLimitType: 'seven_day_oi' }))).toEqual({
      scope: { family: 'Fable' }
    })
  })

  it('carries the reset in milliseconds, whichever unit the service gave', () => {
    expect(
      limitReportOf('claude', rejected({ rateLimitType: 'seven_day', resetsAt: 1790193600 }))
    ).toEqual({ scope: 'shared', resetsAt: 1790193600000 })
    expect(
      limitReportOf('claude', rejected({ rateLimitType: 'seven_day', resetsAt: 1790193600000 }))
    ).toEqual({ scope: 'shared', resetsAt: 1790193600000 })
    expect(limitReportOf('claude', rejected({ rateLimitType: 'seven_day', resetsAt: 0 }))).toEqual({
      scope: 'shared'
    })
  })

  it('reads the window the event shows spent when it carries no type', () => {
    expect(
      limitReportOf(
        'claude',
        rejected({
          unifiedWindows: {
            five_hour: { utilization: 0.4, resetsAt: 10 },
            seven_day_opus: { utilization: 1, resetsAt: 20 }
          }
        })
      )
    ).toEqual({ scope: { family: 'Opus' }, resetsAt: 20000 })
    expect(
      limitReportOf(
        'claude',
        rejected({ resetsAt: 5, unifiedWindows: { seven_day: { utilization: 1.02 } } })
      )
    ).toEqual({ scope: 'shared', resetsAt: 5000 })
    // Nothing spent in the windows either: the CLI said refused, and no more.
    expect(
      limitReportOf('claude', rejected({ unifiedWindows: { seven_day: { utilization: 0.3 } } }))
    ).toEqual({ scope: 'unknown' })
  })

  it("reads the synthetic reply as the account's credits, or as the family it names", () => {
    // The reply of 2026-09-26: the CLI ended right after it, exit 143.
    expect(
      limitReportOf(
        'claude',
        synthetic(
          "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
        )
      )
    ).toEqual({ scope: 'credits' })
    expect(
      limitReportOf(
        'claude',
        synthetic('Your organization is out of usage credits. Contact your admin to add more.')
      )
    ).toEqual({ scope: 'credits' })
    expect(
      limitReportOf('claude', synthetic('Fable limit reached. Switch to another model.'))
    ).toEqual({ scope: { family: 'Fable' } })
    expect(limitReportOf('claude', synthetic('Opus weekly limit reached.'))).toEqual({
      scope: { family: 'Opus' }
    })
    // A synthetic notice about something else, or a real model's reply that
    // happens to discuss limits, is nothing.
    expect(limitReportOf('claude', synthetic('[Request interrupted by user]'))).toBeNull()
    expect(
      limitReportOf(
        'claude',
        synthetic("You're out of usage credits, it says here", 'claude-opus-5-5')
      )
    ).toBeNull()
    expect(
      limitReportOf('claude', { type: 'assistant', message: { model: '<synthetic>' } })
    ).toBeNull()
  })

  it('replays the real turn: its allowed rate-limit events report nothing, and the same event rejected names its scope and reset', () => {
    const lines = readFileSync(
      path.join(__dirname, 'fixtures/claude-stream/real-turn.ndjson'),
      'utf8'
    )
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const events = lines.filter((frame) => frame.type === 'rate_limit_event')
    expect(events.length).toBeGreaterThan(0)
    for (const frame of lines) expect(limitReportOf('claude', frame)).toBeNull()
    const info = events[0].rate_limit_info as Record<string, unknown>
    expect(info.rateLimitType).toBe('five_hour')
    expect(
      limitReportOf('claude', { ...events[0], rate_limit_info: { ...info, status: 'rejected' } })
    ).toEqual({ scope: 'shared', resetsAt: (info.resetsAt as number) * 1000 })
    // The week's own window, typed by the service's enum, is a shared cap too;
    // the Fable week has no value in that enum and types itself as this.
    expect(
      limitReportOf('claude', {
        ...events[0],
        rate_limit_info: { ...info, status: 'rejected', rateLimitType: 'seven_day' }
      })
    ).toEqual({ scope: 'shared', resetsAt: (info.resetsAt as number) * 1000 })
  })
})

describe('limitReportOf, Codex and the rest', () => {
  const frame = (rateLimits: unknown): unknown => ({
    method: 'account/rateLimits/updated',
    params: { rateLimits }
  })
  it("reads Codex's rate-limit update at the cap or with a reached type: the general allowance is shared", () => {
    expect(limitReportOf('codex', frame({ primary: { usedPercent: 96 } }))).toEqual({
      scope: 'shared'
    })
    expect(
      limitReportOf(
        'codex',
        frame({ limitId: 'codex', primary: { usedPercent: 96, resetsAt: 1789227620 } })
      )
    ).toEqual({ scope: 'shared', resetsAt: 1789227620000 })
    expect(
      limitReportOf(
        'codex',
        frame({ primary: { usedPercent: 40 }, rateLimitReachedType: 'weekly' })
      )
    ).toEqual({ scope: 'shared' })
    expect(
      limitReportOf(
        'codex',
        frame({ primary: { usedPercent: 40 }, secondary: { usedPercent: 10 } })
      )
    ).toBeNull()
    expect(limitReportOf('codex', { method: 'thread/started', params: {} })).toBeNull()
  })

  it("names a Codex bucket's family the way the usage read does: its limitName, else its id (integration round 1, F7)", () => {
    // The legacy single bucket carrying its name.
    expect(
      limitReportOf(
        'codex',
        frame({ limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 100 } })
      )
    ).toEqual({ scope: { family: 'Spark' } })
    expect(
      limitReportOf('codex', frame({ limitId: 'spark', primary: { usedPercent: 100 } }))
    ).toEqual({
      scope: { family: 'spark' }
    })
    // The multi-bucket shape: the first bucket at its cap names the scope.
    const multi = (byId: unknown): unknown => ({
      method: 'account/rateLimits/updated',
      params: { rateLimitsByLimitId: byId, rateLimits: { primary: { usedPercent: 10 } } }
    })
    expect(
      limitReportOf(
        'codex',
        multi({
          codex: { primary: { usedPercent: 40 }, secondary: { usedPercent: 20 } },
          spark: {
            limitName: 'Spark',
            primary: { usedPercent: 20 },
            secondary: { usedPercent: 97, resetsAt: 1789227620 }
          }
        })
      )
    ).toEqual({ scope: { family: 'Spark' }, resetsAt: 1789227620000 })
    expect(
      limitReportOf(
        'codex',
        multi({
          codex: { rateLimitReachedType: 'weekly', primary: { usedPercent: 40 } },
          spark: { limitName: 'Spark', primary: { usedPercent: 10 } }
        })
      )
    ).toEqual({ scope: 'shared' })
    // Nothing at its cap in any bucket: nothing.
    expect(
      limitReportOf(
        'codex',
        multi({
          codex: { primary: { usedPercent: 40 } },
          spark: { limitName: 'Spark', primary: { usedPercent: 50 } }
        })
      )
    ).toBeNull()
  })

  it('is nothing for another provider, or a frame that is not an object', () => {
    expect(limitReportOf('pi', { type: 'rate_limit_event' })).toBeNull()
    expect(limitReportOf('claude', 'rate_limit_event')).toBeNull()
    expect(limitReportOf('codex', null)).toBeNull()
  })

  it('providerEventReportsLimit is the yes of a report', () => {
    expect(providerEventReportsLimit('claude', rejected({ rateLimitType: 'five_hour' }))).toBe(true)
    expect(providerEventReportsLimit('claude', { type: 'system' })).toBe(false)
  })
})
