import { describe, expect, it } from 'vitest'
import { LOCAL_SERVER_ID, resourceKey } from '@clave/contract/fleet'
import { panelRoots } from './panel-roots'
import type { Workspace } from '../store/workspace-store'

const serverWorkspace = resourceKey('workspace', 'vps', 'workspace')
const workspace = (id: string, rootDir: string): Workspace => ({
  id,
  name: id,
  rootDir,
  profileFile: null,
  createdAt: 1
})
const defaults = {
  activeWorkspaceId: serverWorkspace,
  workspaces: {
    workspaces: [workspace('mac', '/mac')],
    serverWorkspaces: { vps: [workspace(serverWorkspace, '/server')] }
  },
  sessionCwd: null,
  legacyRemote: false
}

describe('the side panel owner and roots', () => {
  it('uses the server workspace with no focused tab', () => {
    expect(panelRoots(defaults)).toEqual({
      panelOwner: 'vps',
      scopeRoots: { session: null, group: null, workspace: '/server' }
    })
  })
  it('uses a server session and group in their own workspace', () => {
    expect(
      panelRoots({
        ...defaults,
        activeWorkspaceId: 'mac',
        focusedOwnerKey: resourceKey('session', 'vps', 'session'),
        focusedSession: { workspaceId: serverWorkspace },
        focusedGroup: { id: resourceKey('group', 'vps', 'group'), cwd: '/server/group' },
        sessionCwd: '/server/group/session'
      })
    ).toEqual({
      panelOwner: 'vps',
      scopeRoots: {
        session: '/server/group/session',
        group: '/server/group',
        workspace: '/server'
      }
    })
  })
  it('keeps a Mac session, group and workspace unchanged', () => {
    expect(
      panelRoots({
        ...defaults,
        focusedOwnerKey: 'local-session',
        focusedSession: { workspaceId: 'mac' },
        focusedGroup: { id: 'local-group', cwd: '/mac/group' },
        sessionCwd: '/mac/group/session'
      })
    ).toEqual({
      panelOwner: LOCAL_SERVER_ID,
      scopeRoots: { session: '/mac/group/session', group: '/mac/group', workspace: '/mac' }
    })
  })
  it('ignores a group and workspace of another owner', () => {
    const roots = panelRoots({
      ...defaults,
      activeWorkspaceId: 'mac',
      focusedOwnerKey: resourceKey('session', 'vps', 'session'),
      focusedGroup: { id: 'mac-group', cwd: '/mac/group' },
      sessionCwd: '/server/session'
    })
    expect(roots.scopeRoots).toEqual({ session: '/server/session', group: null, workspace: null })
  })
  it('takes the owner from a focused file tab', () => {
    expect(
      panelRoots({
        ...defaults,
        focusedOwnerKey: resourceKey('file', 'peer', '/peer/notes.txt'),
        sessionCwd: '/peer'
      })
    ).toEqual({
      panelOwner: 'peer',
      scopeRoots: { session: '/peer', group: null, workspace: null }
    })
  })
  it('keeps legacy remote panels rooted only at their session', () => {
    expect(
      panelRoots({
        ...defaults,
        activeWorkspaceId: 'mac',
        focusedOwnerKey: 'ssh-session',
        focusedSession: { workspaceId: 'mac' },
        focusedGroup: { id: 'local-group', cwd: '/mac/group' },
        sessionCwd: '/ssh/session',
        legacyRemote: true
      })
    ).toEqual({
      panelOwner: LOCAL_SERVER_ID,
      scopeRoots: { session: '/ssh/session', group: null, workspace: null }
    })
  })
})
