/**
 * The words of Settings › Slideless and « Create link » (PRDCT-4266): each
 * line a profile's row says, the action its fix offers, the site the dialog
 * starts on, the link's settings as the server takes them, and a refusal in
 * the server's own words. Sites, hubs and addresses are invented.
 */
import { describe, expect, it } from 'vitest'
import type {
  SlidelessAccounts,
  SlidelessProfile,
  SlidelessProfileFix
} from '@clave/contract/artefacts/model'
import {
  DEFAULT_LINK_FIELDS,
  PASSWORD_TOO_SHORT,
  actionOf,
  behindLine,
  checkLine,
  dayAfter,
  defaultSite,
  endOfDay,
  environmentLines,
  hostOf,
  linkFieldsProblem,
  linkSettings,
  normalOrigin,
  offersPastedKey,
  prefilledAddress,
  prefilledHub,
  profileAt,
  profileTitle,
  refusalText,
  sameOrigin,
  signInLine,
  signInStatus,
  siteLabel
} from './slideless-accounts'

const DECKS = 'https://decks.example.test'
const CLOUD = 'https://cloud.example.test'
const LOCAL = 'http://127.0.0.1:3400'
const HUB = 'https://hub.example.test'
const EMAIL = 'someone@example.test'

function profile(
  over: {
    origin?: string
    name?: string | null
    hub?: string | null
    signIn?: Partial<SlidelessProfile['signIn']>
    cliBehind?: boolean | null
    siteCli?: string | null
    environment?: SlidelessProfile['environment']
    isDefault?: boolean
  } = {}
): SlidelessProfile {
  return {
    name: 'decks',
    default: over.isDefault ?? false,
    saved: true,
    site: {
      origin: over.origin ?? DECKS,
      name: over.name === undefined ? 'Decks' : over.name,
      hub: over.hub === undefined ? HUB : over.hub,
      federated: true,
      cliVersion: over.siteCli === undefined ? '0.15.0' : over.siteCli,
      seenAt: null
    },
    cliBehind: over.cliBehind === undefined ? false : over.cliBehind,
    signIn: {
      state: 'signed_in',
      via: 'login',
      hub: HUB,
      email: EMAIL,
      staleKeys: 0,
      fix: null,
      ...over.signIn
    },
    environment: over.environment ?? []
  }
}

function listing(
  profiles: SlidelessProfile[],
  newLinksSite: string | null = null
): SlidelessAccounts {
  return {
    machine: 'test-machine',
    cliVersion: '0.15.0',
    defaultSite: DECKS,
    environment: { url: null, key: false, hubUrl: null },
    logins: [],
    profiles,
    newLinksSite,
    checked: false,
    error: null,
    needsUpdate: false
  }
}

const fix = (kind: string): SlidelessProfileFix => ({ kind, argv: ['slideless', 'login'] })

describe('origins and names', () => {
  it('compares sites in the server’s one form', () => {
    expect(normalOrigin('HTTPS://Decks.Example.Test:443/')).toBe(DECKS)
    expect(normalOrigin(' http://127.0.0.1:3400/ ')).toBe(LOCAL)
    expect(sameOrigin(`${DECKS}/`, DECKS)).toBe(true)
    expect(sameOrigin(DECKS, CLOUD)).toBe(false)
    expect(sameOrigin(null, DECKS)).toBe(false)
  })

  it('names a site by its name, else its host', () => {
    expect(hostOf(LOCAL)).toBe('127.0.0.1:3400')
    expect(hostOf('not an address')).toBe('not an address')
    expect(profileTitle(profile())).toBe('Decks')
    expect(profileTitle(profile({ origin: LOCAL, name: null }))).toBe('127.0.0.1:3400')
    const accounts = listing([profile(), profile({ origin: CLOUD, name: 'Cloud' })])
    expect(profileAt(accounts, `${CLOUD}/`)?.site.name).toBe('Cloud')
    expect(siteLabel(accounts, CLOUD)).toBe('Cloud')
    expect(siteLabel(accounts, 'https://gone.example.test')).toBe('gone.example.test')
  })
})

describe('who signs a site in', () => {
  it('says the login, the key, the first use and a missing sign-in', () => {
    expect(signInLine(profile())).toBe(`Signed in as ${EMAIL} through hub.example.test`)
    expect(signInLine(profile({ signIn: { email: null } }))).toBe(
      'Signed in through hub.example.test'
    )
    expect(signInLine(profile({ signIn: { via: 'key' } }))).toBe(
      `Signed in with its own key as ${EMAIL}`
    )
    expect(signInLine(profile({ signIn: { via: 'key', email: null } }))).toBe(
      'Signed in with its own key'
    )
    expect(signInLine(profile({ signIn: { state: 'will_sign_in' } }))).toBe(
      `Signs in by itself at its first use, as ${EMAIL}`
    )
    expect(signInLine(profile({ signIn: { state: 'needs_login', via: null, email: null } }))).toBe(
      'Not signed in'
    )
  })

  it('says « Not checked yet » for an unknown state and for keys it cannot count, whatever else it says', () => {
    expect(signInLine(profile({ signIn: { state: 'unknown' } }))).toBe('Not checked yet')
    expect(signInLine(profile({ signIn: { staleKeys: null } }))).toBe('Not checked yet')
    expect(signInLine(profile({ signIn: { state: 'needs_login', staleKeys: null } }))).toBe(
      'Not checked yet'
    )
  })

  it('says nothing of a state it does not know', () => {
    expect(signInLine(profile({ signIn: { state: 'a_newer_state' } }))).toBe('')
  })

  it('gives each state its tone, as .status-text takes it', () => {
    expect(signInStatus('signed_in')).toEqual({ label: 'Signed in', tone: 'connected' })
    expect(signInStatus('will_sign_in').tone).toBe('connected')
    expect(signInStatus('needs_login').tone).toBe('connecting')
    expect(signInStatus('unknown').tone).toBeUndefined()
    expect(signInStatus('a_newer_state')).toEqual({ label: 'a newer state', tone: undefined })
  })
})

describe('what the check said', () => {
  it('says nothing before a check', () => {
    expect(checkLine(profile({ signIn: { checked: 'ok' } }), false)).toBeNull()
  })

  it('says each answer of the check', () => {
    const person = { name: 'Some One', email: EMAIL, workspace: null }
    expect(checkLine(profile({ signIn: { checked: 'ok', person } }), true)).toBe(
      'Answers as Some One'
    )
    expect(
      checkLine(profile({ signIn: { checked: 'ok', person: { ...person, name: null } } }), true)
    ).toBe(`Answers as ${EMAIL}`)
    expect(checkLine(profile({ signIn: { checked: 'key_refused' } }), true)).toBe(
      'The site refused the key'
    )
    expect(checkLine(profile({ signIn: { checked: 'unreachable' } }), true)).toBe(
      'The site did not answer'
    )
    expect(checkLine(profile({ signIn: { checked: 'no_key' } }), true)).toBe('No key to check')
    expect(checkLine(profile({ signIn: { checked: 'a_newer_answer' } }), true)).toBeNull()
  })

  it('says a command older than its site, and each variable of the environment', () => {
    expect(behindLine(profile({ cliBehind: true, siteCli: '0.15.1' }), '0.15.0')).toBe(
      "Clave's Slideless 0.15.0 is older than this site's 0.15.1"
    )
    expect(behindLine(profile({ cliBehind: false }), '0.15.0')).toBeNull()
    expect(behindLine(profile({ cliBehind: null }), '0.15.0')).toBeNull()
    expect(
      environmentLines(
        profile({
          environment: [
            { variable: 'SLIDELESS_API_KEY', effect: 'replaces' },
            { variable: 'SLIDELESS_URL', effect: 'refuses' },
            { variable: 'OTHER', effect: 'a_newer_effect' }
          ]
        })
      )
    ).toEqual([
      "SLIDELESS_API_KEY replaces this account's key here",
      'SLIDELESS_URL refuses this site here'
    ])
  })
})

describe('the action a row offers', () => {
  it('reads each kind of fix, and none for a kind it does not know', () => {
    expect(actionOf(fix('hub_login'))).toEqual({ kind: 'sign_in', asks: 'nothing' })
    expect(actionOf(fix('email_code'))).toEqual({ kind: 'sign_in', asks: 'nothing' })
    expect(actionOf(fix('pick_hub'))).toEqual({ kind: 'sign_in', asks: 'hub' })
    expect(actionOf(fix('pick_login'))).toEqual({ kind: 'sign_in', asks: 'address' })
    expect(actionOf(fix('paste_key'))).toEqual({ kind: 'paste_key' })
    expect(actionOf(fix('check'))).toEqual({ kind: 'check' })
    expect(actionOf(fix('remove_profile'))).toEqual({ kind: 'remove' })
    expect(actionOf(fix('a_kind_of_a_newer_command'))).toBeNull()
    expect(actionOf(null)).toBeNull()
  })

  it('offers a pasted key beside every sign-in, and nowhere else', () => {
    for (const kind of ['hub_login', 'email_code', 'pick_hub', 'pick_login'])
      expect(offersPastedKey(fix(kind))).toBe(true)
    for (const kind of ['paste_key', 'check', 'remove_profile', 'a_newer_kind'])
      expect(offersPastedKey(fix(kind))).toBe(false)
    expect(offersPastedKey(null)).toBe(false)
  })

  it('starts a sign-in with the profile’s address, else the login’s at its hub', () => {
    const logins = [
      { hub: 'https://other-hub.example.test', email: 'other@example.test', name: 'other' },
      { hub: `${HUB}/`, email: EMAIL, name: 'hub' }
    ]
    expect(prefilledAddress(profile({ signIn: { email: 'own@example.test' } }), logins)).toBe(
      'own@example.test'
    )
    expect(prefilledAddress(profile({ signIn: { email: null } }), logins)).toBe(EMAIL)
    expect(prefilledAddress(profile({ hub: null, signIn: { email: null } }), logins)).toBe('')
    expect(prefilledHub(profile(), logins)).toBe(`${HUB}/`)
    expect(prefilledHub(profile({ hub: null }), logins)).toBe('https://other-hub.example.test')
    expect(prefilledHub(profile(), [])).toBe('')
  })
})

describe('« Create link »', () => {
  it('starts on « New links go to » when it is a site of the listing, else the first', () => {
    const profiles = [profile(), profile({ origin: CLOUD, name: 'Cloud' })]
    expect(defaultSite(listing(profiles, `${CLOUD}/`))).toBe(CLOUD)
    expect(defaultSite(listing(profiles, 'https://gone.example.test'))).toBe(DECKS)
    expect(defaultSite(listing(profiles, null))).toBe(DECKS)
    expect(defaultSite(listing([], CLOUD))).toBe('')
    expect(defaultSite(null)).toBe('')
  })

  it('sends the switches as they are and leaves out what was not given', () => {
    const settings = linkSettings(DEFAULT_LINK_FIELDS)
    expect(settings).toEqual({
      annotator: false,
      forms: true,
      download: true,
      bar: true,
      pdf: true,
      pinVersion: false
    })
    expect('password' in settings).toBe(false)
    expect('name' in settings).toBe(false)
    expect('expiresAt' in settings).toBe(false)
  })

  it('sends a name, a day and a password when they are given', () => {
    const settings = linkSettings({
      ...DEFAULT_LINK_FIELDS,
      name: '  For the board  ',
      expires: '2026-12-31',
      password: 'hunter22',
      pinVersion: true
    })
    expect(settings.name).toBe('For the board')
    expect(settings.password).toBe('hunter22')
    expect(settings.pinVersion).toBe(true)
    expect(settings.expiresAt).toBe(endOfDay('2026-12-31'))
    expect(new Date(settings.expiresAt!).getDate()).toBe(31)
    expect(new Date(settings.expiresAt!).getHours()).toBe(23)
  })

  it('refuses a password shorter than four characters, and only that', () => {
    expect(linkFieldsProblem({ ...DEFAULT_LINK_FIELDS, password: 'abc' })).toBe(PASSWORD_TOO_SHORT)
    expect(linkFieldsProblem({ ...DEFAULT_LINK_FIELDS, password: 'abcd' })).toBeNull()
    expect(linkFieldsProblem(DEFAULT_LINK_FIELDS)).toBeNull()
  })

  it('reads a day the way a date input writes it', () => {
    expect(endOfDay('not a day')).toBeNull()
    expect(dayAfter(new Date(2026, 10, 26), 7)).toBe('2026-12-03')
    expect(dayAfter(new Date(2026, 11, 30), 3)).toBe('2027-01-02')
  })
})

describe('a refusal in the server’s own words', () => {
  it('drops what Electron and the error’s name put before the sentence', () => {
    const sentence = 'https://gone.example.test is not one of this machine’s Slideless sites.'
    expect(
      refusalText(
        new Error(
          `Error invoking remote method 'artefacts:addSlidelessSite': ArtefactRefused: ${sentence}`
        )
      )
    ).toBe(sentence)
    expect(
      refusalText(new Error(`Error invoking remote method 'artefacts:x': Error: ${sentence}`))
    ).toBe(sentence)
    expect(refusalText({ _tag: 'ArtefactRefused', message: sentence })).toBe(sentence)
    expect(refusalText(sentence)).toBe(sentence)
    expect(refusalText(undefined)).toBe('Slideless did not answer.')
    expect(refusalText(new Error(''), 'Nothing came back.')).toBe('Nothing came back.')
  })
})
