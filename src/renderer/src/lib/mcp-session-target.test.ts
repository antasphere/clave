import { describe, expect, it } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import { resolveSessionTarget } from './mcp-session-target'
import type { Workspace } from '../../../shared/workspace-types'
const connections = [
  { id: 'a', name: 'Claudius', url: 'http://a', enabled: true },
  { id: 'b', name: 'Second server', url: 'http://b', enabled: true },
  { id: 'off', name: 'Disabled', url: 'http://off', enabled: false }
]
const ws = (id: string, name = 'Antasphere'): Workspace => ({
  id,
  name,
  rootDir: '/repo',
  profileFile: null,
  createdAt: 1
})
const remote = resourceKey('workspace', 'a', 'ws')
const defaults = {
  connections,
  workspaces: [ws('local-ws'), ws(remote)],
  defaultWorkspaceId: 'local-ws'
}
describe('MCP destination ownership', () => {
  it('defaults to the caller workspace and keeps local launches compatible', () => {
    expect(resolveSessionTarget(defaults)).toEqual({ serverId: 'local', workspaceId: 'local-ws' })
  })
  it('resolves server IDs and case-insensitive names without inheriting Mac workspace', () => {
    for (const server of ['a', 'claudius'])
      expect(resolveSessionTarget({ ...defaults, server })).toEqual({ serverId: 'a' })
  })
  it('follows remote caller workspace, explicit workspace or group', () => {
    expect(resolveSessionTarget({ ...defaults, defaultWorkspaceId: remote }).serverId).toBe('a')
    expect(resolveSessionTarget({ ...defaults, workspace: remote }).serverId).toBe('a')
    expect(
      resolveSessionTarget({
        ...defaults,
        group: { id: resourceKey('group', 'a', 'g'), workspaceId: remote }
      })
    ).toEqual({ serverId: 'a', workspaceId: remote })
  })
  it('scopes colliding workspace names by server and refuses ambiguity without it', () => {
    expect(
      resolveSessionTarget({ ...defaults, server: 'a', workspace: 'Antasphere' }).workspaceId
    ).toBe(remote)
    expect(() => resolveSessionTarget({ ...defaults, workspace: 'Antasphere' })).toThrow(
      'Ambiguous workspace'
    )
  })
  it('refuses unknown, disabled and ambiguous servers', () => {
    for (const server of ['nope', 'off'])
      expect(() => resolveSessionTarget({ ...defaults, server })).toThrow()
    expect(() =>
      resolveSessionTarget({
        ...defaults,
        connections: [...connections, { ...connections[1], name: 'Claudius' }],
        server: 'Claudius'
      })
    ).toThrow('Ambiguous server')
  })
  it('refuses conflicting owners and workspace membership before spawning', () => {
    expect(() => resolveSessionTarget({ ...defaults, server: 'local', workspace: remote })).toThrow(
      'another server'
    )
    expect(() =>
      resolveSessionTarget({
        ...defaults,
        server: 'b',
        group: { id: resourceKey('group', 'a', 'g') }
      })
    ).toThrow('another server')
    expect(() =>
      resolveSessionTarget({
        ...defaults,
        server: 'a',
        workspace: remote,
        group: { id: resourceKey('group', 'a', 'g'), workspaceId: 'different' }
      })
    ).toThrow('another workspace')
  })
  it('keeps an unstamped remote caller on its server when the window shows the Mac', () => {
    expect(resolveSessionTarget({ ...defaults, callerServerId: 'a' })).toEqual({ serverId: 'a' })
    expect(resolveSessionTarget({ ...defaults, callerServerId: 'a', server: 'local' })).toEqual({
      serverId: 'local',
      workspaceId: 'local-ws'
    })
  })
  it('explicit local drops a remote caller workspace', () => {
    expect(
      resolveSessionTarget({ ...defaults, server: 'local', defaultWorkspaceId: remote })
    ).toEqual({ serverId: 'local' })
  })
})

// PRDCT-4193: a server tab opened from a Mac tab used to land in no workspace
// of that server, so the coordinator could not see it where it works. The
// placement only fills the gap: anything naming a workspace or a group still
// decides, and a Mac launch is never moved.
describe('server tab placement when nothing names a workspace (PRDCT-4193)', () => {
  const at = (id: string, rootDir: string): Workspace => ({ ...ws(id), rootDir })
  const shallow = resourceKey('workspace', 'a', 'repo')
  const deep = resourceKey('workspace', 'a', 'sub')
  const other = resourceKey('workspace', 'b', 'repo')
  const placing = {
    connections,
    workspaces: [
      at('local-ws', '/repo'),
      at(shallow, '/repo'),
      at(deep, '/repo/sub'),
      at(other, '/repo/sub/x')
    ],
    defaultWorkspaceId: 'local-ws'
  }
  it('takes the paired workspace when exactly one belongs to the server', () => {
    expect(
      resolveSessionTarget({
        ...placing,
        server: 'a',
        pairedWorkspaceIds: [other, shallow],
        cwd: '/repo/sub'
      })
    ).toEqual({ serverId: 'a', workspaceId: shallow })
  })
  it("falls to the directory when two paired workspaces are that server's", () => {
    expect(
      resolveSessionTarget({
        ...placing,
        server: 'a',
        pairedWorkspaceIds: [shallow, deep],
        cwd: '/repo/sub/pkg'
      })
    ).toEqual({ serverId: 'a', workspaceId: deep })
  })
  it('places by the deepest root of the server holding the directory', () => {
    expect(resolveSessionTarget({ ...placing, server: 'a', cwd: '/repo/sub' }).workspaceId).toBe(
      deep
    )
    expect(resolveSessionTarget({ ...placing, server: 'a', cwd: '/repo/subway' }).workspaceId).toBe(
      shallow
    )
    expect(resolveSessionTarget({ ...placing, server: 'a', cwd: '/repo' }).workspaceId).toBe(
      shallow
    )
  })
  it('leaves the tab in no workspace when neither the pairing nor the directory places it', () => {
    expect(resolveSessionTarget({ ...placing, server: 'a', cwd: '/elsewhere' })).toEqual({
      serverId: 'a'
    })
    expect(resolveSessionTarget({ ...placing, server: 'a', pairedWorkspaceIds: [other] })).toEqual({
      serverId: 'a'
    })
  })
  it('keeps an explicit workspace or group ahead of the placement', () => {
    expect(
      resolveSessionTarget({
        ...placing,
        workspace: shallow,
        pairedWorkspaceIds: [deep],
        cwd: '/repo/sub'
      })
    ).toEqual({ serverId: 'a', workspaceId: shallow })
    expect(
      resolveSessionTarget({
        ...placing,
        group: { id: resourceKey('group', 'a', 'g'), workspaceId: shallow },
        pairedWorkspaceIds: [deep],
        cwd: '/repo/sub'
      })
    ).toEqual({ serverId: 'a', workspaceId: shallow })
  })
  it('never places a Mac launch in a workspace by the directory or the pairing', () => {
    expect(
      resolveSessionTarget({
        ...placing,
        server: 'local',
        defaultWorkspaceId: shallow,
        pairedWorkspaceIds: ['local-ws'],
        cwd: '/repo'
      })
    ).toEqual({ serverId: 'local' })
  })
  it('names the way out when the group belongs to another server', () => {
    expect(() =>
      resolveSessionTarget({
        ...placing,
        server: 'b',
        group: { id: resourceKey('group', 'a', 'g') }
      })
    ).toThrow(
      'The target group belongs to another server. Omit groupId, or pass a group of that server from clave_list.'
    )
  })
})

describe('a server root saved with a trailing slash (round 2, R09b)', () => {
  it('holds its own directory as well as the ones under it', () => {
    const slashed = { ...ws(remote), rootDir: '/srv/x/' }
    const base = { ...defaults, workspaces: [ws('local-ws'), slashed], server: 'a' }
    expect(resolveSessionTarget({ ...base, cwd: '/srv/x' }).workspaceId).toBe(remote)
    expect(resolveSessionTarget({ ...base, cwd: '/srv/x/' }).workspaceId).toBe(remote)
    expect(resolveSessionTarget({ ...base, cwd: '/srv/x/deeper' }).workspaceId).toBe(remote)
    expect(resolveSessionTarget({ ...base, cwd: '/srv/xy' }).workspaceId).toBeUndefined()
  })
})

describe('a pairing to a workspace the server no longer lists (round 3, C3)', () => {
  it('is skipped, and the directory decides', () => {
    const gone = resourceKey('workspace', 'a', 'removed')
    const held = { ...ws(remote), rootDir: '/srv/repo' }
    const base = { ...defaults, workspaces: [ws('local-ws'), held], server: 'a' }
    expect(
      resolveSessionTarget({ ...base, pairedWorkspaceIds: [gone], cwd: '/srv/repo/x' }).workspaceId
    ).toBe(remote)
    expect(
      resolveSessionTarget({ ...base, pairedWorkspaceIds: [gone], cwd: '/elsewhere' }).workspaceId
    ).toBeUndefined()
    // A listed pairing still wins over the directory.
    expect(
      resolveSessionTarget({ ...base, pairedWorkspaceIds: [remote], cwd: '/elsewhere' }).workspaceId
    ).toBe(remote)
  })
})
