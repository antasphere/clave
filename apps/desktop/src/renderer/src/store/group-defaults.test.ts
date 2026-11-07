/**
 * What the group `+` inherits from the `.clave` — the brief AND the directory.
 *
 * The directory half is the one that fails silently: a `+` that opens in the
 * project dir looks exactly like one that opens at the workspace root until you
 * read the shell prompt in the new tab, and the agent inside it only finds out
 * when a path it was briefed on isn't there. The fleet's files all declare
 * `rootSession: true` on the session carrying the brief, so this is the shape
 * every project group in the workspace actually has.
 */

import { describe, expect, it } from 'vitest'
import { findBackingPin, resolveGroupDefaults, resolveGroupLaunchCwd } from './group-defaults'
import type { PinnedGroup, PinnedGroupSession } from './session-types'

const session = (over: Partial<PinnedGroupSession> = {}): PinnedGroupSession => ({
  cwd: '/root/labs/widget',
  name: 'Widget',
  claudeMode: true,
  antigravityMode: false,
  codexMode: false,
  dangerousMode: false,
  ...over
})

const pin = (over: Partial<PinnedGroup> = {}): PinnedGroup => ({
  id: 'pin-1',
  name: 'Widget',
  cwd: '/root/labs/widget',
  color: null,
  prompt: null,
  sessions: [],
  terminals: [],
  createdAt: 1,
  workspaceId: 'ws-1',
  activeGroupId: null,
  visible: false,
  ...over
})

describe('resolveGroupDefaults', () => {
  it('takes brief and root anchor from the entry session — the fleet shape', () => {
    expect(
      resolveGroupDefaults({
        prompt: null,
        sessions: [session({ rootSession: true, prompt: 'the widget brief' })]
      })
    ).toEqual({ prompt: 'the widget brief', rootSession: true })
  })

  it('leaves a group whose sessions open in its own dir alone', () => {
    expect(
      resolveGroupDefaults({ prompt: null, sessions: [session({ prompt: 'the widget brief' })] })
    ).toEqual({ prompt: 'the widget brief', rootSession: false })
  })

  it('lets a group-level prompt override the text, never the anchor', () => {
    expect(
      resolveGroupDefaults({
        prompt: 'the group says otherwise',
        sessions: [session({ rootSession: true, prompt: 'the session brief' })]
      })
    ).toEqual({ prompt: 'the group says otherwise', rootSession: true })
  })

  it('prefers the root session that carries a brief over one that does not', () => {
    expect(
      resolveGroupDefaults({
        prompt: null,
        sessions: [
          session({ prompt: 'a plain brief' }),
          session({ rootSession: true, prompt: 'the root brief' })
        ]
      })
    ).toEqual({ prompt: 'the root brief', rootSession: true })
  })

  it('anchors a silent group from its first session — no brief needed', () => {
    expect(
      resolveGroupDefaults({ prompt: null, sessions: [session({ rootSession: true })] })
    ).toEqual({ prompt: null, rootSession: true })
  })

  it('answers for a group that declares no sessions at all', () => {
    expect(resolveGroupDefaults({ prompt: null, sessions: [] })).toEqual({
      prompt: null,
      rootSession: false
    })
  })
})

describe('findBackingPin', () => {
  const group = {
    id: 'grp-1',
    name: 'Widget',
    cwd: '/root/labs/widget',
    prompt: 'the widget brief' as string | null,
    workspaceId: 'ws-1' as string | undefined
  }
  const backing = pin({ sessions: [session({ rootSession: true, prompt: 'the widget brief' })] })

  it('takes the live link when the pin still has one', () => {
    const other = pin({ id: 'pin-2', name: 'Something else', activeGroupId: 'grp-1' })
    expect(findBackingPin(group, [backing, other])?.id).toBe('pin-2')
  })

  it('identifies an unlinked pin by workspace, name, dir and brief', () => {
    // The link dies with the window, so after a restart this is the only way
    // back to the declaration — and the only way a group stamped before the
    // anchor existed gets it.
    expect(findBackingPin(group, [backing])?.id).toBe('pin-1')
  })

  it('refuses a pin carrying a different brief', () => {
    const impostor = pin({ sessions: [session({ rootSession: true, prompt: 'someone else' })] })
    expect(findBackingPin(group, [impostor])).toBeNull()
  })

  it('refuses a same-named pin from another workspace', () => {
    expect(
      findBackingPin(group, [pin({ workspaceId: 'ws-2', sessions: backing.sessions })])
    ).toBeNull()
  })

  it('refuses a same-named pin rooted somewhere else', () => {
    expect(
      findBackingPin(group, [pin({ cwd: '/root/labs/other', sessions: backing.sessions })])
    ).toBeNull()
  })
})

describe('resolveGroupLaunchCwd', () => {
  const live = {
    id: 'grp-1',
    name: 'Widget',
    cwd: '/root/labs/widget',
    prompt: 'the widget brief' as string | null,
    workspaceId: 'ws-1' as string | undefined
  }
  const rooted = pin({ sessions: [session({ rootSession: true, prompt: 'the widget brief' })] })
  const local = pin({ sessions: [session({ prompt: 'the widget brief' })] })

  it('sends a root-anchored group to the workspace root', () => {
    expect(resolveGroupLaunchCwd({ ...live, rootSession: true }, [])).toEqual({
      kind: 'workspace-root'
    })
  })

  it('keeps every other group in its own directory', () => {
    expect(resolveGroupLaunchCwd({ ...live, rootSession: false }, [rooted])).toEqual({
      kind: 'path',
      path: '/root/labs/widget'
    })
  })

  it('asks the pin for a group stamped before the anchor existed', () => {
    expect(resolveGroupLaunchCwd(live, [rooted])).toEqual({ kind: 'workspace-root' })
  })

  it('and takes its no for an answer', () => {
    expect(resolveGroupLaunchCwd(live, [local])).toEqual({
      kind: 'path',
      path: '/root/labs/widget'
    })
  })

  it('falls back to the group directory when no pin claims it', () => {
    expect(resolveGroupLaunchCwd(live, [])).toEqual({ kind: 'path', path: '/root/labs/widget' })
  })

  it('sends a group with no directory of its own to the root', () => {
    expect(resolveGroupLaunchCwd({ ...live, cwd: null }, [])).toEqual({ kind: 'workspace-root' })
  })
})
