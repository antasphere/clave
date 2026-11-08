import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@clave/contract/sessions'
import type { SidebarGroup } from '@clave/contract/sidebar'
import { resourceKey } from '@clave/contract/fleet'
import { buildProvenanceHeader } from '../../shared/exchange-provenance'
import { sanitizeForPaste } from '../../shared/paste-sanitize'
import {
  assertCanReach,
  endedMessage,
  findTarget,
  isRelated,
  isServerTabRef,
  readAnswer,
  resolveTarget,
  resumeTarget,
  sendToTarget,
  type SendIo,
  type TargetHost
} from './session-targets'

/**
 * The one target rule both agent-tool surfaces share (PRDCT-4192), on a fake
 * host: which tab a reference names, whether the caller may reach it, the
 * self-addressed send as a checkpoint that is never typed (the daemon typed
 * a lane's own checkpoint back into it as its next instruction), the
 * refusals and the shapes answered. The host's facts are the only input, so
 * a fake host pins the rule for the desktop and the daemon at once.
 */
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  ...{ id, provider: 'claude', transport: 'pty', cwd: '/work', windowKey: 'wA', state: 'idle' },
  ...{ createdAt: 0, adapterId: 'pty', title: `title-${id}` },
  ...extra
})
const group = (id: string, extra: Partial<SidebarGroup> = {}): SidebarGroup => ({
  ...{ id, name: id, sessionIds: [], collapsed: false, cwd: null, terminals: [] },
  ...extra
})
const terminal = (id: string, sessionId: string | null): SidebarGroup['terminals'][number] => ({
  ...{ id, command: 'npm run dev', commandMode: 'auto' as const, color: 'green' },
  sessionId
})

interface FakeWorld {
  caller?: string
  sessions: Session[]
  names?: Record<string, string>
  modes?: Record<string, string>
  parents?: Record<string, string>
  groups?: SidebarGroup[]
  routedKey?: string
}

/** A host over a mutable world, so a resume can change what `get` answers. */
function fakeHost(w: FakeWorld): TargetHost & { world: FakeWorld } {
  return {
    world: w,
    caller: w.caller,
    routedKey: w.routedKey,
    get: async (id) => w.sessions.find((s) => s.id === id) ?? null,
    list: async () => w.sessions,
    nameOf: (s) => w.names?.[s.id] ?? `name-${s.id}`,
    modeOf: (s) => w.modes?.[s.id] ?? 'claude',
    parentOf: (id) => w.parents?.[id] ?? null,
    groups: async () => w.groups ?? []
  }
}

function fakeIo(overrides: Partial<SendIo> = {}): SendIo & {
  checkpoint: ReturnType<typeof vi.fn>
  type: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
} {
  return {
    checkpoint: vi.fn(async () => true),
    type: vi.fn(async () => ({ submitted: true, draftHandling: 'none' })),
    resume: vi.fn(async () => undefined),
    capture: vi.fn(),
    ...overrides
  } as never
}

describe('isServerTabRef (PRDCT-4166, PRDCT-4193)', () => {
  it('is true for a key of another server, false for a local key, a bare id and junk', () => {
    expect(isServerTabRef(resourceKey('session', 'srv-1', 'abc'))).toBe(true)
    // A local resource key collapses to the bare id, so a "local" spelling is
    // never a server tab: the host serving the tool owns it.
    expect(isServerTabRef(resourceKey('session', 'local', 'abc'))).toBe(false)
    expect(isServerTabRef('abc')).toBe(false)
    expect(isServerTabRef('clave-owner:garbage')).toBe(false)
    expect(isServerTabRef(resourceKey('group', 'srv-1', 'g'))).toBe(false)
    expect(isServerTabRef(undefined)).toBe(false)
    expect(isServerTabRef(42)).toBe(false)
  })
})

describe('findTarget / resolveTarget', () => {
  const world = (): FakeWorld => ({
    caller: 'me',
    sessions: [
      session('me'),
      session('boss'),
      session('dupA', { windowKey: 'wA' }),
      session('dupB', { windowKey: 'wB' })
    ],
    names: { dupA: 'twin', dupB: 'twin' },
    parents: { me: 'boss' }
  })

  it('finds by id before by name', async () => {
    const w = world()
    // A tab whose NAME is another tab's id: the id wins.
    w.names = { ...w.names, boss: 'me' }
    expect((await findTarget(fakeHost(w), 'me'))?.id).toBe('me')
  })
  it('an exact name resolves, the routed window’s tab first', async () => {
    expect((await findTarget(fakeHost({ ...world(), routedKey: 'wB' }), 'twin'))?.id).toBe('dupB')
    expect((await findTarget(fakeHost({ ...world(), routedKey: 'wA' }), 'twin'))?.id).toBe('dupA')
    // No routed window: the first named tab.
    expect((await findTarget(fakeHost(world()), 'twin'))?.id).toBe('dupA')
    // A routed window holding none of them falls back to the first.
    expect((await findTarget(fakeHost({ ...world(), routedKey: 'wZ' }), 'twin'))?.id).toBe('dupA')
  })
  it('a name is matched exactly, never by prefix', async () => {
    expect(await findTarget(fakeHost(world()), 'twi')).toBeNull()
  })
  it('resolves "parent" from the host’s parentOf', async () => {
    expect((await resolveTarget(fakeHost(world()), 'parent')).id).toBe('boss')
  })
  it('refuses unknown text by naming it', async () => {
    await expect(resolveTarget(fakeHost(world()), 'nobody')).rejects.toThrow(
      'No session with id or name "nobody"'
    )
  })
  it('refuses "parent" without a caller', async () => {
    await expect(
      resolveTarget(fakeHost({ ...world(), caller: undefined }), 'parent')
    ).rejects.toThrow('Target "parent" requires the call to come from inside a Clave session')
  })
  it('refuses "parent" when no parent is known or it is gone', async () => {
    const text =
      'This session has no live parent — only tabs opened via clave_open_session know their opener, and that tab is no longer open. Use clave_list and target a session id or name instead.'
    await expect(resolveTarget(fakeHost({ ...world(), parents: {} }), 'parent')).rejects.toThrow(
      text
    )
    await expect(
      resolveTarget(fakeHost({ ...world(), parents: { me: 'gone' } }), 'parent')
    ).rejects.toThrow(text)
  })
})

describe('isRelated / assertCanReach', () => {
  const groups = [
    group('g', { sessionIds: ['me', 'sib'], terminals: [terminal('t1', 'dev')] }),
    group('far', { sessionIds: ['stranger'], terminals: [terminal('t2', 'far-dev')] })
  ]
  const host = fakeHost({
    caller: 'me',
    sessions: ['me', 'boss', 'kid', 'sib', 'dev', 'stranger', 'far-dev'].map((id) => session(id)),
    parents: { me: 'boss', kid: 'me' },
    groups
  })

  it('relates self, opener, opened, a groupmate and the group’s terminal; nothing else', () => {
    expect(isRelated(host, groups, 'me', 'me')).toBe(true)
    expect(isRelated(host, groups, 'me', 'boss')).toBe(true)
    expect(isRelated(host, groups, 'me', 'kid')).toBe(true)
    expect(isRelated(host, groups, 'me', 'sib')).toBe(true)
    expect(isRelated(host, groups, 'me', 'dev')).toBe(true)
    expect(isRelated(host, groups, 'me', 'stranger')).toBe(false)
    // Another group's terminal is not reached through a group the caller is not in.
    expect(isRelated(host, groups, 'me', 'far-dev')).toBe(false)
  })
  it('lets a related target through', async () => {
    await expect(assertCanReach(host, session('kid'), 'message')).resolves.toBeUndefined()
  })
  it('refuses an unrelated tab with the verb and the way to allow it', async () => {
    await expect(assertCanReach(host, session('stranger'), 'read')).rejects.toThrow(
      'Refusing to read tab "name-stranger": it is not related to yours. You can only reach the tab that opened yours ("parent"), tabs you opened, or tabs in the same group. Put both tabs in one group to allow this.'
    )
  })
  it('refuses a caller with no identity, naming the tool of the verb', async () => {
    const anon = fakeHost({ sessions: [session('x')] })
    const cases: Array<[Parameters<typeof assertCanReach>[2], string]> = [
      ['message', 'clave_send_to_session'],
      ['read', 'clave_read_session'],
      ['resume', 'clave_resume_session']
    ]
    for (const [verb, tool] of cases) {
      await expect(assertCanReach(anon, session('x'), verb)).rejects.toThrow(
        `${tool} must be called from inside a Clave agent tab — this request has no tab identity.`
      )
    }
  })
})

describe('sendToTarget', () => {
  const world = (): FakeWorld => ({
    caller: 'me',
    sessions: [
      session('me'),
      session('kid'),
      session('stranger'),
      session('term'),
      session('menu')
    ],
    names: { me: 'Lane', kid: 'Kid' },
    modes: { term: 'terminal', menu: 'claude-agents' },
    parents: { kid: 'me', term: 'me', menu: 'me' }
  })

  it('"mine" is a checkpoint: logged, never typed, never resumed', async () => {
    const io = fakeIo()
    const answer = await sendToTarget(fakeHost(world()), { ref: 'mine', message: 'note' }, io)
    expect(io.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'me' }),
      'Lane',
      'note'
    )
    expect(io.type).not.toHaveBeenCalled()
    expect(io.resume).not.toHaveBeenCalled()
    expect(io.capture).not.toHaveBeenCalled()
    expect(answer).toEqual({
      checkpoint: true,
      logged: true,
      delivered: false,
      sessionId: 'me',
      name: 'Lane',
      note: 'Checkpoint logged to the transport record; nothing was typed into any tab.'
    })
  })
  it('the caller’s own id (and own name) is a checkpoint too; logged false says so', async () => {
    for (const ref of ['me', 'Lane']) {
      const io = fakeIo({ checkpoint: vi.fn(() => false) })
      const answer = await sendToTarget(fakeHost(world()), { ref, message: 'note' }, io)
      expect(io.type).not.toHaveBeenCalled()
      expect(io.resume).not.toHaveBeenCalled()
      expect(answer).toEqual({
        checkpoint: true,
        logged: false,
        delivered: false,
        sessionId: 'me',
        name: 'Lane',
        note: 'Checkpoint taken; this server keeps no transport record, and nothing was typed into any tab.'
      })
    }
  })
  it('a checkpoint to an ended self is still never resumed', async () => {
    const w = world()
    w.sessions[0] = session('me', { state: 'ended' })
    const io = fakeIo()
    await sendToTarget(fakeHost(w), { ref: 'me', message: 'x', resume: true }, io)
    expect(io.resume).not.toHaveBeenCalled()
    expect(io.type).not.toHaveBeenCalled()
  })
  it('"mine" with a caller the host does not know is refused', async () => {
    await expect(
      sendToTarget(
        fakeHost({ ...world(), caller: 'ghost' }),
        { ref: 'mine', message: 'x' },
        fakeIo()
      )
    ).rejects.toThrow('Calling session not found')
  })
  it('an unrelated target is refused before anything is typed', async () => {
    const io = fakeIo()
    await expect(
      sendToTarget(fakeHost(world()), { ref: 'stranger', message: 'x' }, io)
    ).rejects.toThrow('Refusing to message tab "name-stranger"')
    expect(io.type).not.toHaveBeenCalled()
  })
  it('an ended target without resume is refused with the way back', async () => {
    const w = world()
    w.sessions[1] = session('kid', { state: 'ended' })
    const io = fakeIo()
    await expect(sendToTarget(fakeHost(w), { ref: 'kid', message: 'x' }, io)).rejects.toThrow(
      endedMessage('Kid')
    )
    expect(endedMessage('Kid')).toBe(
      'Session "Kid" has ended; resume it with clave_resume_session, or pass resume: true to resume it and deliver.'
    )
    expect(io.resume).not.toHaveBeenCalled()
    expect(io.type).not.toHaveBeenCalled()
  })
  it('an ended target with resume: true is resumed first, re-read, then typed', async () => {
    const w = world()
    w.sessions[1] = session('kid', { state: 'ended' })
    const order: string[] = []
    const io = fakeIo({
      resume: vi.fn(async () => {
        order.push('resume')
        // The resumed process: the host now answers it running.
        w.sessions[1] = session('kid', { state: 'working' })
      }),
      type: vi.fn(async (target: Session) => {
        order.push(`type:${target.state}`)
        return { submitted: true, draftHandling: 'none' }
      })
    })
    const answer = (await sendToTarget(
      fakeHost(w),
      { ref: 'kid', message: 'go', resume: true },
      io
    )) as Record<string, unknown>
    expect(order).toEqual(['resume', 'type:working'])
    expect(answer).toMatchObject({ delivered: true, sessionId: 'kid', agentState: 'working' })
  })
  it('refuses a plain terminal and a claude agents menu', async () => {
    const io = fakeIo()
    await expect(
      sendToTarget(fakeHost(world()), { ref: 'term', message: 'ls' }, io)
    ).rejects.toThrow(
      'Refusing to send to a plain terminal — text typed there would run as a shell command. Target an agent tab (claude/antigravity/codex).'
    )
    await expect(
      sendToTarget(fakeHost(world()), { ref: 'menu', message: 'x' }, io)
    ).rejects.toThrow(
      'Refusing to send to a `claude agents` tab — it is a menu UI, not a chat input'
    )
    expect(io.type).not.toHaveBeenCalled()
  })
  it('types the sanitized provenance header and the sanitized message, and captures them', async () => {
    const io = fakeIo()
    const message = 'hello\x07 world\x1b'
    const answer = await sendToTarget(fakeHost(world()), { ref: 'Kid', message }, io)
    const header = sanitizeForPaste(buildProvenanceHeader({ id: 'me', name: 'Lane' }))
    const clean = sanitizeForPaste(message)
    expect(clean).toBe('hello world')
    expect(io.type).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kid' }),
      `${header}\n${clean}`,
      'Lane'
    )
    expect(io.capture).toHaveBeenCalledWith({
      sender: expect.objectContaining({ id: 'me' }),
      target: expect.objectContaining({ id: 'kid' }),
      text: clean,
      provenance: header,
      delivered: true
    })
    expect(answer).toEqual({
      delivered: true,
      sessionId: 'kid',
      name: 'Kid',
      mode: 'claude',
      agentState: 'idle',
      draftHandling: 'none'
    })
  })
  it('captures delivered false when the target ended during the typing', async () => {
    const w = world()
    const io = fakeIo({
      type: vi.fn(async () => {
        w.sessions[1] = session('kid', { state: 'ended' })
        return { submitted: true, draftHandling: 'none' }
      })
    })
    const answer = await sendToTarget(fakeHost(w), { ref: 'kid', message: 'x' }, io)
    expect(io.capture).toHaveBeenCalledWith(expect.objectContaining({ delivered: false }))
    expect(answer).toMatchObject({ delivered: false })
  })
  it('no capture when the submit did not land, a Pi tab is on either side, or the host keeps none', async () => {
    const notSubmitted = fakeIo({
      type: vi.fn(async () => ({ submitted: false, draftHandling: 'x' }))
    })
    await sendToTarget(fakeHost(world()), { ref: 'kid', message: 'x' }, notSubmitted)
    expect(notSubmitted.capture).not.toHaveBeenCalled()

    const piTarget = fakeIo()
    await sendToTarget(
      fakeHost({ ...world(), modes: { kid: 'pi' } }),
      { ref: 'kid', message: 'x' },
      piTarget
    )
    expect(piTarget.type).toHaveBeenCalled()
    expect(piTarget.capture).not.toHaveBeenCalled()

    const piSender = fakeIo()
    await sendToTarget(
      fakeHost({ ...world(), modes: { me: 'pi' } }),
      { ref: 'kid', message: 'x' },
      piSender
    )
    expect(piSender.capture).not.toHaveBeenCalled()

    const noCapture: SendIo = { ...fakeIo(), capture: undefined }
    await expect(
      sendToTarget(fakeHost(world()), { ref: 'kid', message: 'x' }, noCapture)
    ).resolves.toMatchObject({ delivered: true })
  })
})

describe('resumeTarget', () => {
  const world = (): FakeWorld => ({
    caller: 'me',
    sessions: [
      session('me'),
      session('kid', { state: 'ended' }),
      session('stranger', { state: 'ended' })
    ],
    names: { kid: 'Kid' },
    modes: { kid: 'codex' },
    parents: { kid: 'me' }
  })

  it('refuses a running tab: there is nothing to resume', async () => {
    const resume = vi.fn(async () => ({ resumed: true }))
    const w = world()
    w.sessions[1] = session('kid', { state: 'working' })
    await expect(resumeTarget(fakeHost(w), 'kid', resume)).rejects.toThrow(
      'Session "Kid" is running; there is nothing to resume.'
    )
    expect(resume).not.toHaveBeenCalled()
  })
  it('resumes an ended related tab and answers the shape', async () => {
    const w = world()
    const resume = vi.fn(async () => {
      w.sessions[1] = session('kid', { state: 'idle' })
      return { resumed: false }
    })
    const answer = await resumeTarget(fakeHost(w), 'Kid', resume)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ id: 'kid', state: 'ended' }))
    expect(answer).toEqual({
      resumed: true,
      sessionId: 'kid',
      name: 'Kid',
      mode: 'codex',
      alive: true,
      // The conversation did not come along: the tab started fresh.
      conversation: false
    })
  })
  it('enforces the reach before restarting anything', async () => {
    const resume = vi.fn(async () => ({ resumed: true }))
    await expect(resumeTarget(fakeHost(world()), 'stranger', resume)).rejects.toThrow(
      'Refusing to resume tab "name-stranger"'
    )
    expect(resume).not.toHaveBeenCalled()
  })
})

describe('readAnswer', () => {
  const host = fakeHost({ sessions: [], names: { s: 'S' }, modes: { s: 'claude' } })
  it('drops the trailing blank rows and keeps the inner ones', () => {
    expect(readAnswer(host, session('s', { state: 'working' }), ['a', '', 'b', '  ', ''])).toEqual({
      sessionId: 's',
      name: 'S',
      mode: 'claude',
      alive: true,
      agentState: 'working',
      lines: 3,
      text: 'a\n\nb'
    })
  })
  it('an ended tab reads not alive with no agent state; all-blank reads empty', () => {
    expect(readAnswer(host, session('s', { state: 'ended' }), ['', ' '])).toMatchObject({
      alive: false,
      agentState: null,
      lines: 0,
      text: ''
    })
  })
})
