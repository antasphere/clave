import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { FakeSettingsSource } from '@clave/server/settings/test-support'
import { CapabilityUnavailable, SettingsRefused } from '@clave/contract/settings'
import { type ClaveApiClient, createApiClient } from './api'

let server: EmbeddedServer
let fake: FakeSettingsSource
let api: ClaveApiClient

beforeEach(async () => {
  fake = new FakeSettingsSource()
  server = await startEmbedded({ ports: { sessions: new FakeSource(), settings: fake } })
  api = createApiClient({ url: server.url, token: server.token })
})
afterEach(async () => {
  await api.dispose()
  await server.stop()
})

const last = (method: string): unknown[] | undefined =>
  fake.calls.filter((c) => c.method === method).at(-1)?.args

describe('the typed settings calls', () => {
  it('adds and lists Claude accounts, and sets a token', async () => {
    const account = await api.settings.claudeAccounts.add('Work')
    expect(account).toMatchObject({ label: 'Work', hasToken: false })
    expect(await api.settings.claudeAccounts.list()).toEqual([account])
    const read = await api.settings.claudeAccounts.setToken(account.id, 'sk-ant-oat01-x')
    expect(read).toHaveProperty('windows')
    expect(fake.secrets).toEqual(['sk-ant-oat01-x'])
  })

  it('sends the usage parameters as the server decodes them', async () => {
    await api.settings.usage.readClaude('a', { force: true })
    expect(last('usage.readClaude')).toEqual(['a', true])
    await api.settings.usage.readClaude()
    expect(last('usage.readClaude')).toEqual([undefined, false])
    await api.settings.usage.readClaude('b', { force: false })
    expect(last('usage.readClaude')).toEqual(['b', false])
    expect(await api.settings.usage.readPi('30d')).toMatchObject({ range: '30d' })
  })

  it('throws a manager’s refusal as the contract’s tagged error, its sentence as the message', async () => {
    const account = await api.settings.claudeAccounts.add('Work')
    const error = await api.settings.claudeAccounts
      .setToken(account.id, 'not-a-token')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SettingsRefused)
    expect((error as Error).message).toBe(
      'That does not look like a Claude Code token (expected sk-ant-…).'
    )
  })

  it('throws a refused capability as the contract’s tagged error', async () => {
    fake.refuse.login = true
    const error = await api.settings.logins.start('claude', 'a').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CapabilityUnavailable)
    expect(error).toMatchObject({ capability: 'login' })
  })

  it('sets the app icon and writes the workspaces, the origin carried as given', async () => {
    expect(await api.settings.preferences.setAppIcon('dark')).toBeUndefined()
    expect(last('preferences.setAppIcon')).toEqual(['dark'])
    expect(await api.settings.workspaces.updatePins('bad', [])).toEqual({
      ok: false,
      reason: 'invalid-key'
    })
    expect(await api.settings.workspaces.updateRegistry([], 'w1')).toEqual({ ok: true })
    expect(last('workspaces.updateRegistry')).toEqual([[], 'w1'])
    await api.settings.workspaces.updateRegistry([])
    expect(last('workspaces.updateRegistry')).toEqual([[], undefined])
    expect(await api.settings.workspaces.setLastActive('ws1')).toBeUndefined()
    expect(fake.state.lastActiveWorkspaceId).toBe('ws1')
  })

  it('upserts a launch profile', async () => {
    const profile = {
      id: 'p',
      name: 'P',
      family: 'claude' as const,
      command: ['claude'],
      additionalArgs: []
    }
    const preferences = await api.settings.launchProfiles.upsert(profile)
    expect(preferences.customProfiles).toContainEqual(profile)
  })
})

describe('the Antasphere account calls', () => {
  it('reads the status, signs in with the handoff in the answer, and the rest answer the status', async () => {
    expect(typeof api.settings.antasphere?.status).toBe('function')
    expect(await api.settings.antasphere.status()).toMatchObject({ phase: 'signed-out' })
    const signedIn = await api.settings.antasphere.signIn()
    expect(signedIn.status.phase).toBe('signing-in')
    expect(signedIn.handoff).toEqual({
      url: 'https://issuer.test/authorize?state=s1',
      generation: 1
    })
    expect(await api.settings.antasphere.confirmHandoff(signedIn.handoff!)).toBe(true)
    expect(
      await api.settings.antasphere.confirmHandoff({ ...signedIn.handoff!, generation: 9 })
    ).toBe(false)
    expect(await api.settings.antasphere.cancel()).toMatchObject({ lastFailure: 'cancelled' })
    expect(await api.settings.antasphere.confirmHandoff(signedIn.handoff!)).toBe(false)
    expect(await api.settings.antasphere.dismiss()).toMatchObject({ lastFailure: null })
    expect(await api.settings.antasphere.signOut()).toMatchObject({ phase: 'signed-out' })
    expect(last('antasphere.signOut')).toEqual([])
  })

  it('throws the refusal of a server without the account as the tagged error', async () => {
    fake.refuse.antasphere = true
    const error = await api.settings.antasphere.signIn().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CapabilityUnavailable)
    expect(error).toMatchObject({ capability: 'antasphereAccount' })
  })
})
