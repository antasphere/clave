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
  it('explicit local drops a remote caller workspace', () => {
    expect(
      resolveSessionTarget({ ...defaults, server: 'local', defaultWorkspaceId: remote })
    ).toEqual({ serverId: 'local' })
  })
})
