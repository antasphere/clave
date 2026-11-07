import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_PAIRING_COLORS } from '../../../packages/contract/src/fleet'
import { fileStorage } from '../ports/storage'
import type { SettingsPorts } from '../ports/registry'
import { ServerPairingRegistry } from './pairings'

describe('the paired workspaces of this Mac (PRDCT-4151)', () => {
  let dir: string
  let ports: SettingsPorts
  let registry: ServerPairingRegistry
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clave-srv-a-pairings-'))
    ports = {
      storage: fileStorage(dir),
      secrets: {
        available: async () => false,
        seal: async () => {
          throw new Error('unused')
        },
        open: async () => undefined,
        discard: async () => {}
      }
    }
    registry = new ServerPairingRegistry(ports)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('starts empty, and a confirmed pairing turns the server on with the first free colour', () => {
    expect(registry.load()).toEqual({ version: 1, servers: {} })
    const state = registry.change({
      kind: 'confirm',
      serverId: 'studio',
      serverWorkspaceId: 'ws-1',
      localWorkspaceId: 'mac-1'
    })
    expect(state.servers.studio).toEqual({
      combine: true,
      color: SERVER_PAIRING_COLORS[0],
      pairs: { 'ws-1': 'mac-1' },
      declined: []
    })
    const second = registry.change({ kind: 'combine', serverId: 'vps', on: true })
    expect(second.servers.vps.color).toBe(SERVER_PAIRING_COLORS[1])
    const reload = new ServerPairingRegistry(ports)
    expect(reload.load()).toEqual(second)
    expect(JSON.parse(readFileSync(join(dir, 'server-pairings.json'), 'utf8'))).toEqual(second)
  })

  it('keeps a switch turned off through a later confirmation, and a decline is not proposed again', () => {
    registry.change({ kind: 'combine', serverId: 'studio', on: false })
    const state = registry.change({
      kind: 'confirm',
      serverId: 'studio',
      serverWorkspaceId: 'ws-1',
      localWorkspaceId: 'mac-1'
    })
    expect(state.servers.studio.combine).toBe(false)
    expect(state.servers.studio.pairs).toEqual({ 'ws-1': 'mac-1' })
    const declined = registry.change({
      kind: 'decline',
      serverId: 'studio',
      serverWorkspaceId: 'ws-2'
    })
    expect(declined.servers.studio.declined).toEqual(['ws-2'])
    // Confirming a declined workspace later takes it off the declined list.
    const confirmed = registry.change({
      kind: 'confirm',
      serverId: 'studio',
      serverWorkspaceId: 'ws-2',
      localWorkspaceId: 'mac-2'
    })
    expect(confirmed.servers.studio.declined).toEqual([])
    const forgotten = registry.change({
      kind: 'forget',
      serverId: 'studio',
      serverWorkspaceId: 'ws-1'
    })
    expect(forgotten.servers.studio.pairs).toEqual({ 'ws-2': 'mac-2' })
  })

  it('undoes a decline on Ask again, and forgets every decline when the switch is turned on', () => {
    registry.change({ kind: 'decline', serverId: 'studio', serverWorkspaceId: 'ws-3' })
    registry.change({ kind: 'decline', serverId: 'studio', serverWorkspaceId: 'ws-4' })
    const asked = registry.change({
      kind: 'ask-again',
      serverId: 'studio',
      serverWorkspaceId: 'ws-3'
    })
    expect(asked.servers.studio.declined).toEqual(['ws-4'])
    const off = registry.change({ kind: 'combine', serverId: 'studio', on: false })
    expect(off.servers.studio.declined).toEqual(['ws-4'])
    const on = registry.change({ kind: 'combine', serverId: 'studio', on: true })
    expect(on.servers.studio).toMatchObject({ combine: true, declined: [] })
    expect(() =>
      registry.change({ kind: 'ask-again', serverId: 'studio', serverWorkspaceId: '' })
    ).toThrow(/workspace/)
  })

  it('refuses a nameless change and reads a damaged file field by field', () => {
    expect(() =>
      registry.change({
        kind: 'confirm',
        serverId: '',
        serverWorkspaceId: 'a',
        localWorkspaceId: 'b'
      })
    ).toThrow(/server/)
    expect(() =>
      registry.change({
        kind: 'confirm',
        serverId: 's',
        serverWorkspaceId: 'a',
        localWorkspaceId: ''
      })
    ).toThrow(/workspaces/)
    writeFileSync(
      join(dir, 'server-pairings.json'),
      JSON.stringify({
        version: 1,
        servers: {
          good: {
            combine: true,
            color: '#5e6ad2',
            pairs: { 'ws-1': 'mac-1', 7: 3 },
            declined: ['x', 4]
          },
          bad: { color: 'red', pairs: {} },
          worse: 'nope'
        }
      })
    )
    const fresh = new ServerPairingRegistry(ports)
    expect(fresh.load()).toEqual({
      version: 1,
      servers: {
        good: { combine: true, color: '#5e6ad2', pairs: { 'ws-1': 'mac-1' }, declined: ['x'] }
      }
    })
    writeFileSync(join(dir, 'server-pairings.json'), '{ not json')
    expect(new ServerPairingRegistry(ports).load()).toEqual({ version: 1, servers: {} })
  })
})
