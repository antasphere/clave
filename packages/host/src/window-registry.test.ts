import { describe, it, expect } from 'vitest'
import { WindowRegistry, type WindowLike } from './window-registry'

/**
 * The WindowRegistry's rules, without Electron. Every rule here is one the
 * multi-window teardown, the spawn stamp, or the MCP routing leans on; a
 * registry that gets one wrong fails SILENTLY — a spawn stamped with the wrong
 * workspace or a tool call landing in the wrong window looks fine until
 * someone opens a second window.
 */
class FakeWindow implements WindowLike {
  private destroyed = false
  constructor(readonly id: number) {}
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
  }
}

function setup(focused: () => FakeWindow | null = () => null): {
  reg: WindowRegistry<FakeWindow>
  win: (id: number, ws: string | null, key?: string) => FakeWindow
} {
  const reg = new WindowRegistry<FakeWindow>({ getFocusedWindow: focused })
  return {
    reg,
    win: (id, ws, key = `key-${id}`) => {
      const w = new FakeWindow(id)
      reg.registerWindow(w, key, ws)
      return w
    }
  }
}

describe('primary election', () => {
  it('the first registered window is the primary', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    win(2, 'B')
    expect(reg.getPrimaryWindow()).toBe(a)
    expect(reg.isPrimary(1)).toBe(true)
    expect(reg.isPrimary(2)).toBe(false)
  })

  it('re-elects the lowest surviving id when the primary closes', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    win(3, 'C')
    const b = win(2, 'B')
    a.destroy()
    reg.unregisterWindow(1)
    expect(reg.getPrimaryWindow()).toBe(b)
  })

  it('keeps the primary when a non-primary closes', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    const b = win(2, 'B')
    b.destroy()
    reg.unregisterWindow(2)
    expect(reg.getPrimaryWindow()).toBe(a)
  })

  it('never returns a destroyed window as primary, even before unregister', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    const b = win(2, 'B')
    a.destroy()
    expect(reg.getPrimaryWindow()).toBe(b)
  })

  it('returns null with no windows', () => {
    const { reg } = setup()
    expect(reg.getPrimaryWindow()).toBeNull()
  })
})

describe('window identity', () => {
  it('knows each window by id and by key, and the workspace it shows', () => {
    const { reg, win } = setup()
    const a = win(1, 'A', 'ka')
    expect(reg.getWindowByKey('ka')).toBe(a)
    expect(reg.getKeyForWindow(1)).toBe('ka')
    expect(reg.getWorkspaceForWindow(1)).toBe('A')
    expect(reg.getWindowByKey('nope')).toBeNull()
    expect(reg.getKeyForWindow(9)).toBeNull()
  })

  it('several windows may show the same workspace', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    const b = win(2, 'A')
    win(3, 'B')
    expect(reg.getWindowsForWorkspace('A')).toEqual([a, b])
  })

  it('follows a switch, and the switch touches no other window', () => {
    const { reg, win } = setup()
    win(1, 'A')
    win(2, 'A')
    reg.setWindowWorkspace(2, 'B')
    expect(reg.getWorkspaceForWindow(1)).toBe('A')
    expect(reg.getWorkspaceForWindow(2)).toBe('B')
  })

  it('a destroyed window is dropped from keys, lists and lookups', () => {
    const { reg, win } = setup()
    win(1, 'A', 'ka')
    const b = win(2, 'A', 'kb')
    b.destroy()
    expect(reg.liveKeys()).toEqual(new Set(['ka']))
    expect(reg.getWindowByKey('kb')).toBeNull()
    expect(reg.listWindows().map((w) => w.id)).toEqual([1])
  })
})

describe('session hosting', () => {
  it('binds a session to a window and lists it back', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    win(2, 'B')
    reg.bindSession('s1', 1)
    reg.bindSession('s2', 1)
    reg.bindSession('s3', 2)
    expect(reg.getWindowForSession('s1')).toBe(a)
    expect(reg.getSessionsForWindow(1).sort()).toEqual(['s1', 's2'])
    expect(reg.getSessionsForWindow(2)).toEqual(['s3'])
  })

  it('unbind forgets exactly that session', () => {
    const { reg, win } = setup()
    win(1, 'A')
    reg.bindSession('s1', 1)
    reg.bindSession('s2', 1)
    reg.unbindSession('s1')
    expect(reg.getWindowForSession('s1')).toBeNull()
    expect(reg.getSessionsForWindow(1)).toEqual(['s2'])
  })

  it('a re-bind moves the session (the move case)', () => {
    const { reg, win } = setup()
    win(1, 'A')
    const b = win(2, 'B')
    reg.bindSession('s1', 1)
    reg.bindSession('s1', 2)
    expect(reg.getWindowForSession('s1')).toBe(b)
    expect(reg.getSessionsForWindow(1)).toEqual([])
  })

  it("unregistering a window drops its bindings and no other window's", () => {
    const { reg, win } = setup()
    win(1, 'A')
    const b = win(2, 'B')
    reg.bindSession('s1', 1)
    reg.bindSession('s2', 2)
    reg.unregisterWindow(1)
    expect(reg.getWindowForSession('s1')).toBeNull()
    expect(reg.getWindowForSession('s2')).toBe(b)
  })

  it('a session bound to a destroyed window resolves to null', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    reg.bindSession('s1', 1)
    a.destroy()
    expect(reg.getWindowForSession('s1')).toBeNull()
  })
})

describe('resolveTargetWindow ladder', () => {
  it("rung 1: the subject session's hosting window wins over everything", () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    const b = win(2, 'B')
    reg.bindSession('s1', 2)
    expect(reg.resolveTargetWindow({ sessionId: 's1', windowId: 1 })).toBe(b)
    expect(reg.resolveTargetWindow({ sessionId: 's1' })).toBe(b)
    expect(a).toBeDefined()
  })

  it('rung 2: the explicitly named window', () => {
    const { reg, win } = setup()
    win(1, 'A')
    const b = win(2, 'A')
    expect(reg.resolveTargetWindow({ windowId: 2 })).toBe(b)
    expect(reg.resolveTargetWindow({ sessionId: 'unknown', windowId: 2 })).toBe(b)
  })

  it('rung 3: the focused window when nothing more specific applies', () => {
    let focused: FakeWindow | null = null
    const { reg, win } = setup(() => focused)
    win(1, 'A')
    const b = win(2, 'B')
    focused = b
    expect(reg.resolveTargetWindow({})).toBe(b)
    expect(reg.resolveTargetWindow({ windowId: 99 })).toBe(b)
  })

  it('rung 4: the primary when nothing is focused', () => {
    const { reg, win } = setup()
    const a = win(1, 'A')
    win(2, 'B')
    expect(reg.resolveTargetWindow({})).toBe(a)
    expect(reg.resolveTargetWindow({ sessionId: 'nope' })).toBe(a)
  })

  it('a focused window the registry never saw is ignored', () => {
    const stray = new FakeWindow(42)
    const { reg, win } = setup(() => stray)
    const a = win(1, 'A')
    expect(reg.resolveTargetWindow({})).toBe(a)
  })

  it('null when no window exists at all', () => {
    const { reg } = setup()
    expect(reg.resolveTargetWindow({})).toBeNull()
  })
})

describe('identity', () => {
  it("reports the window's own identity and nothing about other windows", () => {
    const { reg, win } = setup()
    win(1, 'A', 'ka')
    win(2, 'A', 'kb')
    expect(reg.identityOf(2)).toEqual({
      windowId: 2,
      windowKey: 'kb',
      workspaceId: 'A',
      isPrimary: false
    })
    expect(reg.identityOf(1)).toEqual({
      windowId: 1,
      windowKey: 'ka',
      workspaceId: 'A',
      isPrimary: true
    })
    expect(reg.identityOf(7)).toBeNull()
  })

  it('lists live windows lowest id first', () => {
    const { reg, win } = setup()
    win(3, 'C')
    win(1, 'A')
    const b = win(2, 'B')
    b.destroy()
    expect(reg.listWindows().map((w) => w.id)).toEqual([1, 3])
  })
})
