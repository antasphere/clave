import { describe, expect, it } from 'vitest'
import { Either, ParseResult, Schema } from 'effect'
import {
  AddSlidelessSite,
  AnswerSlidelessSignIn,
  Artefact,
  ArtefactDeck,
  ArtefactPreview,
  ArtefactRefused,
  ArtefactShareResult,
  ArtefactVersion,
  GetArtefactDeck,
  HoldArtefactPreview,
  OpenArtefact,
  PasteSlidelessKey,
  RevokeArtefactLink,
  SetNewLinksSite,
  ShareArtefact,
  SlidelessAccounts,
  SlidelessSignIn,
  StartSlidelessSignIn
} from './artefacts'
import { ServerEvent } from './events'

/** The artefacts contract (PRDCT-4472): what the service answers decodes and
 *  encodes unchanged; the events are server events. */
describe('the artefacts contract', () => {
  const artefact = {
    sessionId: 's1',
    target: '/work/deck',
    page: '/work/deck/index.html',
    title: 'deck',
    openedAt: '2026-11-12T10:00:00.000Z'
  }

  it('decodes and encodes an artefact, a preview and a version as the service answers them', () => {
    for (const [schema, value] of [
      [Artefact, artefact],
      [
        ArtefactPreview,
        {
          holdId: 'h1',
          lease: '0123456789abcdef0123456789abcdef',
          url: 'http://127.0.0.1:4100/',
          ttlMs: 90_000
        }
      ],
      [ArtefactVersion, { version: 3, created: false }]
    ] as const) {
      const decoded = Schema.decodeUnknownSync(schema as Schema.Schema<unknown, unknown>)(value)
      expect(decoded).toEqual(value)
      expect(Schema.encodeSync(schema as Schema.Schema<unknown, unknown>)(decoded)).toEqual(value)
    }
  })

  it('refuses a preview whose lease is not a forward lease', () => {
    const bad = Schema.decodeUnknownEither(ArtefactPreview)({
      holdId: 'h1',
      lease: 'not-a-lease',
      url: 'http://127.0.0.1:4100/',
      ttlMs: 1
    })
    expect(Either.isLeft(bad)).toBe(true)
  })

  it('takes a session and a path to open, a hold with or without its id', () => {
    const open = Schema.decodeUnknownEither(OpenArtefact.payload)
    expect(open({ sessionId: 's1', path: '/work/deck' })._tag).toBe('Right')
    expect(open({ sessionId: '', path: '/work/deck' })._tag).toBe('Left')
    expect(open({ sessionId: 's1', path: '' })._tag).toBe('Left')
    const hold = Schema.decodeUnknownEither(HoldArtefactPreview.payload)
    expect(hold({ sessionId: 's1' })._tag).toBe('Right')
    expect(hold({ sessionId: 's1', holdId: 'h1' })._tag).toBe('Right')
  })

  it('keeps the refusal its sentence', () => {
    const refused = new ArtefactRefused({ message: 'This session has no artefact open.' })
    expect(refused._tag).toBe('ArtefactRefused')
    expect(refused.message).toBe('This session has no artefact open.')
  })

  it('carries its three events as server events', () => {
    const decode = Schema.decodeUnknownSync(ServerEvent)
    for (const event of [
      { _tag: 'artefact.changed', sessionId: 's1', artefact },
      { _tag: 'artefact.changed', sessionId: 's1', artefact: null },
      { _tag: 'artefact.preview_exited', sessionId: 's1' },
      {
        _tag: 'slideless.state_changed',
        state: { phase: 'ready', version: '0.14.1', error: null, override: false }
      }
    ])
      expect(decode(event)).toEqual(event)
  })
})

/** The Slideless accounts and an artefact's links (PRDCT-4266): what the
 *  service answers decodes and encodes unchanged, a value the command chooses
 *  is a plain string (a newer command's value decodes), and a secret refused
 *  for its length is never repeated in the refusal. */
describe('the Slideless accounts and the links in the contract', () => {
  const profile = {
    name: 'decks',
    default: true,
    saved: true,
    site: {
      origin: 'https://decks.example.test',
      name: null,
      hub: null,
      federated: null,
      cliVersion: null,
      seenAt: null
    },
    cliBehind: null,
    signIn: {
      state: 'a_state_from_a_newer_command',
      via: null,
      hub: null,
      email: null,
      staleKeys: null,
      fix: { kind: 'a_kind_from_a_newer_command', argv: ['slideless', 'login'] }
    },
    environment: [{ variable: 'SLIDELESS_URL', effect: 'replaces' }]
  }
  const accounts = {
    machine: null,
    cliVersion: '0.15.0',
    defaultSite: 'https://decks.example.test',
    environment: { url: null, key: false, hubUrl: null },
    logins: [{ hub: 'https://hub.example.test', email: null, name: 'hub' }],
    profiles: [
      profile,
      {
        ...profile,
        signIn: {
          ...profile.signIn,
          checked: 'ok',
          person: { name: null, email: 'someone@example.test', workspace: null }
        }
      }
    ],
    newLinksSite: null,
    checked: false,
    error: null,
    needsUpdate: false
  }
  const link = {
    tokenId: 't1',
    name: 'Clave',
    url: 'https://decks.example.test/s/secret',
    createdAt: '2026-11-26T10:00:00.000Z',
    expiresAt: null,
    pinnedVersion: null,
    hasPassword: false
  }
  const deck = {
    target: '/work/deck',
    site: 'https://decks.example.test',
    deckId: 'd1',
    title: 'deck',
    version: 3,
    pushedAt: '2026-11-26T10:00:00.000Z',
    links: [link],
    linkedFolder: null,
    staged: false
  }

  it('decodes and encodes the accounts, a sign-in, a deck and both share results unchanged', () => {
    for (const [schema, value] of [
      [SlidelessAccounts, accounts],
      [
        SlidelessSignIn,
        {
          id: 'i1',
          origin: 'https://decks.example.test',
          phase: 'code_asked',
          email: null,
          message: null
        }
      ],
      [ArtefactDeck, deck],
      [
        ArtefactDeck,
        {
          ...deck,
          site: null,
          deckId: null,
          title: null,
          version: null,
          pushedAt: null,
          links: [],
          linkedFolder: { deckId: 'd2', site: 'http://127.0.0.1:3400' },
          staged: true
        }
      ],
      [ArtefactShareResult, { _tag: 'shared', deck, link }],
      [ArtefactShareResult, { _tag: 'deck_gone', deck }]
    ] as const) {
      const decoded = Schema.decodeUnknownSync(schema as Schema.Schema<unknown, unknown>)(value)
      expect(decoded).toEqual(value)
      expect(Schema.encodeSync(schema as Schema.Schema<unknown, unknown>)(decoded)).toEqual(value)
    }
  })

  const ok = (schema: Schema.Schema.AnyNoContext, value: unknown): boolean =>
    Either.isRight(Schema.decodeUnknownEither(schema)(value))
  const settings = {
    annotator: false,
    forms: true,
    download: true,
    bar: true,
    pdf: true,
    pinVersion: false
  }

  it('takes the payloads the calls declare', () => {
    expect(ok(AddSlidelessSite.payload, { url: 'https://decks.example.test' })).toBe(true)
    expect(ok(AddSlidelessSite.payload, { url: '' })).toBe(false)
    expect(ok(AddSlidelessSite.payload, { url: `https://${'a'.repeat(2048)}` })).toBe(false)
    expect(ok(SetNewLinksSite.payload, { origin: null })).toBe(true)
    expect(ok(SetNewLinksSite.payload, { origin: 'https://decks.example.test' })).toBe(true)
    expect(ok(StartSlidelessSignIn.payload, { origin: 'https://decks.example.test' })).toBe(true)
    expect(
      ok(StartSlidelessSignIn.payload, {
        origin: 'o',
        email: 'someone@example.test',
        hub: 'https://hub.example.test'
      })
    ).toBe(true)
    expect(ok(GetArtefactDeck.payload, { sessionId: 's1', target: '/work/deck' })).toBe(true)
    expect(ok(GetArtefactDeck.payload, { sessionId: 's1' })).toBe(false)
    expect(
      ok(ShareArtefact.payload, { sessionId: 's1', target: '/work/deck', link: settings })
    ).toBe(true)
    expect(
      ok(ShareArtefact.payload, {
        sessionId: 's1',
        target: '/work/deck',
        site: 'https://decks.example.test',
        newDeck: true,
        title: 'Deck',
        link: {
          ...settings,
          name: 'For a client',
          expiresAt: '2026-12-31T00:00:00Z',
          password: 'four'
        }
      })
    ).toBe(true)
    expect(
      ok(ShareArtefact.payload, {
        sessionId: 's1',
        target: '/work/deck',
        link: { ...settings, forms: undefined }
      })
    ).toBe(false)
    expect(
      ok(RevokeArtefactLink.payload, { sessionId: 's1', target: '/work/deck', tokenId: 't1' })
    ).toBe(true)
    expect(
      ok(RevokeArtefactLink.payload, { sessionId: 's1', target: '/work/deck', tokenId: '' })
    ).toBe(false)
  })

  it('refuses a secret for its length with a sentence that never repeats it', () => {
    const refusals: Array<[Schema.Schema.AnyNoContext, unknown, string]> = [
      [
        ShareArtefact.payload,
        { sessionId: 's1', target: '/t', link: { ...settings, password: 'pw7' } },
        'pw7'
      ],
      [AnswerSlidelessSignIn.payload, { id: 'i1', code: '' }, '""'],
      [AnswerSlidelessSignIn.payload, { id: 'i1', code: `code-${'9'.repeat(70)}` }, 'code-999'],
      [AnswerSlidelessSignIn.payload, { id: 'i1', code: 424242 }, '424242'],
      [PasteSlidelessKey.payload, { origin: 'o', key: `slk_${'k'.repeat(600)}` }, 'slk_kkk'],
      [PasteSlidelessKey.payload, { origin: 'o', key: '' }, '""']
    ]
    for (const [schema, value, secret] of refusals) {
      const result = Schema.decodeUnknownEither(schema, { errors: 'all' })(value)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isRight(result)) continue
      const said = [
        ParseResult.TreeFormatter.formatErrorSync(result.left),
        ...ParseResult.ArrayFormatter.formatErrorSync(result.left).map((issue) => issue.message)
      ].join('\n')
      expect(said).not.toContain(secret)
      expect(said).toMatch(/is (at least 4|1 to 64|1 to 512) characters long/)
    }
    // The secrets of the right length pass.
    expect(ok(PasteSlidelessKey.payload, { origin: 'o', key: 'slk_1' })).toBe(true)
    expect(ok(AnswerSlidelessSignIn.payload, { id: 'i1', code: '123456' })).toBe(true)
  })
})
