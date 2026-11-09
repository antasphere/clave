import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { RoutinesListing } from './model'

/**
 * The routines listing across versions (PRDCT-4149, round 1): a newer Mac
 * reads the listing of a server older than the publish and the pinning, so
 * the fields those added must be optional on the wire, or a whole server's
 * routines would vanish from the toolbar on a decode failure.
 */

const declaration = {
  key: '/repo/.clave/workspaces/default.clave::Digest',
  name: 'Digest',
  file: '/repo/.clave/workspaces/default.clave',
  rootDir: '/repo',
  group: 'Ops',
  workspaceId: 'ws',
  workspaceName: 'Workspace',
  schedule: '0 8 * * *',
  prompt: 'go',
  skill: null,
  cwd: '/repo',
  launch: {},
  icon: null,
  color: null,
  catchUp: false,
  timeoutMinutes: 30,
  scope: 'machine',
  invalid: null
}

const run = {
  id: 'run-1',
  routineKey: declaration.key,
  trigger: 'manual',
  startedAt: 1,
  endedAt: 2,
  state: 'ok',
  headline: 'h',
  summary: 's',
  reason: null,
  sessionId: 's1',
  providerSessionId: 'c-s1',
  discussionSessionId: null,
  agent: 'claude',
  form: 'chat',
  model: null,
  account: null,
  deck: 'r/run-1/index.html',
  seen: false
}

const decode = Schema.decodeUnknownSync(RoutinesListing)

describe('the routines listing on the wire', () => {
  it('decodes the listing of an older server: no runsOn, no runsHere, no origin, no publish', () => {
    const older = {
      routines: [
        {
          routine: {
            ...declaration,
            report: { template: '/t', schema: '/s', width: 400, height: 300 }
          },
          nextRunAt: null,
          runs: []
        }
      ],
      viewer: { url: null, note: '' }
    }
    const listing = decode(older)
    expect(listing.server).toBeUndefined()
    expect(listing.routines[0].routine.runsHere).toBeUndefined()
    expect(listing.routines[0].routine.runsOn).toBeUndefined()
    expect(listing.routines[0].routine.origin).toBeUndefined()
    expect(listing.routines[0].routine.report.publish).toBeUndefined()
  })

  it('decodes the listing of this version and keeps every value it carries', () => {
    const current = {
      routines: [
        {
          routine: {
            ...declaration,
            runsOn: 'Studio',
            runsHere: false,
            origin: 'file',
            report: { template: '/t', schema: '/s', width: 400, height: 300, publish: true }
          },
          nextRunAt: 123,
          runs: [
            {
              ...run,
              published: { deckId: 'deck-1', version: 3, url: 'https://s.example/d' },
              publishError: 'the link was not minted'
            }
          ]
        }
      ],
      viewer: { url: 'http://127.0.0.1:4800', note: '' },
      server: { id: 'srv-1', name: 'Studio' }
    }
    const listing = decode(current)
    expect(listing.server).toEqual({ id: 'srv-1', name: 'Studio' })
    const view = listing.routines[0]
    expect(view.routine).toMatchObject({ runsOn: 'Studio', runsHere: false, origin: 'file' })
    expect(view.routine.report.publish).toBe(true)
    expect(view.runs[0]).toMatchObject({
      published: { deckId: 'deck-1', version: 3, url: 'https://s.example/d' },
      publishError: 'the link was not minted'
    })
  })
})

describe('a server name (PRDCT-4241)', () => {
  it('is one word of the install script’s rule and never the word every, whatever its case', async () => {
    const { isServerName } = await import('../server-name')
    for (const ok of ['Studio', 'romains-mac-studio', 'a', 'x'.repeat(63), 'a.b_c-d'])
      expect(isServerName(ok), ok).toBe(true)
    for (const bad of [
      'every',
      'Every',
      'EVERY',
      '',
      ' ',
      'two words',
      '-lead',
      'x'.repeat(64),
      'Stüdio',
      42
    ])
      expect(isServerName(bad), String(bad)).toBe(false)
  })
})
