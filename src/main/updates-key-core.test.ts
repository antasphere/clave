import { describe, expect, it } from 'vitest'
import { resolveKeymapConfig, type ResolvedKeymapConfig } from '../shared/keymaps'
import {
  createUpdatesKey,
  pickWindow,
  readStatus,
  updateAccelerators,
  type UpdatesStatus,
  type WindowMessage
} from './updates-key-core'

const waiting = (at: number): UpdatesStatus => ({
  active: true,
  playing: false,
  speaking: false,
  oldestAt: at
})
const reading: UpdatesStatus = { active: true, playing: true, speaking: true, oldestAt: null }
const saying: UpdatesStatus = { active: true, playing: false, speaking: true, oldestAt: 5 }
const quiet: UpdatesStatus = { active: false, playing: false, speaking: false, oldestAt: null }

/** The core over fakes: what the OS holds, and what each window was sent. */
interface Harness {
  key: ReturnType<typeof createUpdatesKey>
  os: Set<string>
  sent: { id: number; message: WindowMessage }[]
  rebind: (bindings: string[]) => void
  setEverywhere: (value: boolean) => boolean
  to: (id: number, channel: WindowMessage['channel']) => WindowMessage[]
}
function harness(options: { everywhere?: boolean; gone?: number[] } = {}): Harness {
  const os = new Set<string>()
  const sent: { id: number; message: WindowMessage }[] = []
  let config: ResolvedKeymapConfig = resolveKeymapConfig()
  let everywhere = options.everywhere ?? true
  const key = createUpdatesKey({
    register: (accelerator) => {
      os.add(accelerator)
      return true
    },
    unregister: (accelerator) => void os.delete(accelerator),
    send: (id, message) => {
      if (options.gone?.includes(id)) return false
      sent.push({ id, message })
      return true
    },
    bindings: () => config,
    everywhere: () => everywhere,
    platform: 'darwin'
  })
  return {
    key,
    os,
    sent,
    rebind: (bindings: string[]) => {
      config = resolveKeymapConfig({ version: 1, bindings: { playUpdate: bindings } })
    },
    setEverywhere: (value: boolean) => (everywhere = value),
    to: (id: number, channel: WindowMessage['channel']) =>
      sent.filter((s) => s.id === id && s.message.channel === channel).map((s) => s.message)
  }
}

const statuses = (entries: [number, UpdatesStatus][]): Map<number, UpdatesStatus> =>
  new Map(entries)

describe('pickWindow', () => {
  it('a playing window wins', () => {
    expect(
      pickWindow(
        statuses([
          [1, waiting(10)],
          [2, reading]
        ])
      )
    ).toBe(2)
  })
  it('else the window with the oldest update', () => {
    expect(
      pickWindow(
        statuses([
          [1, waiting(30)],
          [2, waiting(10)],
          [3, waiting(20)]
        ])
      )
    ).toBe(2)
  })
  it('else none', () => {
    expect(pickWindow(statuses([]))).toBeNull()
    expect(pickWindow(statuses([[1, quiet]]))).toBeNull()
  })
})

describe('updateAccelerators and readStatus', () => {
  it('the default binding, single chords only', () => {
    expect(updateAccelerators(resolveKeymapConfig(), 'darwin')).toEqual(['Control+Shift+Space'])
    const config = resolveKeymapConfig({
      version: 1,
      bindings: { playUpdate: ['Master P', 'Mod+Shift+L'] }
    })
    expect(updateAccelerators(config, 'linux')).toEqual(['Super+Shift+L'])
  })
  it('reads a status, speaking taken from playing when a window does not say it', () => {
    expect(readStatus({ active: true, playing: false, speaking: true, oldestAt: 5 })).toEqual(
      saying
    )
    expect(readStatus({ active: true, playing: true })).toEqual(reading)
    expect(readStatus(null)).toBeNull()
    expect(readStatus({ active: 'yes' })).toBeNull()
  })
})

describe('the key held system-wide', () => {
  it('while some window is active, and let go when none is', () => {
    const h = harness()
    expect(h.key.held()).toEqual([])
    h.key.report(1, waiting(1))
    expect(h.key.held()).toEqual(['Control+Shift+Space'])
    expect([...h.os]).toEqual(['Control+Shift+Space'])
    h.key.report(1, quiet)
    expect(h.key.held()).toEqual([])
    expect(h.os.size).toBe(0)
  })
  it('never with the preference off; held again once it is on', () => {
    const h = harness({ everywhere: false })
    h.key.report(1, waiting(1))
    expect(h.key.held()).toEqual([])
    h.setEverywhere(true)
    h.key.everywhereChanged()
    expect(h.key.held()).toEqual(['Control+Shift+Space'])
  })
  it('a closed window is forgotten: the key is let go when it was the only active one (M1)', () => {
    const h = harness()
    h.key.report(1, quiet)
    h.key.report(2, waiting(1))
    expect(h.key.held()).toHaveLength(1)
    h.key.closed(2)
    expect(h.key.held()).toEqual([])
    expect(h.os.size).toBe(0)
    expect(h.key.press()).toBe(false)
  })
  it('a keymap change swaps the held accelerators at once (M2)', () => {
    const h = harness()
    h.key.report(1, waiting(1))
    h.rebind(['Mod+Shift+L'])
    h.key.bindingsChanged()
    expect(h.key.held()).toEqual(['Command+Shift+L'])
    expect([...h.os]).toEqual(['Command+Shift+L'])
  })
  it('release on quit lets go of everything', () => {
    const h = harness()
    h.key.report(1, waiting(1))
    h.key.release()
    expect(h.os.size).toBe(0)
  })
})

describe('the press', () => {
  it('goes to the window it concerns', () => {
    const h = harness()
    h.key.report(1, waiting(20))
    h.key.report(2, waiting(10))
    expect(h.key.press()).toBe(true)
    expect(h.to(2, 'updates:toggle')).toHaveLength(1)
    expect(h.to(1, 'updates:toggle')).toHaveLength(0)
  })
  it('a window gone is forgotten', () => {
    const h = harness({ gone: [2] })
    h.key.report(2, waiting(1))
    expect(h.key.press()).toBe(false)
    expect(h.key.held()).toEqual([])
  })
})

describe('one voice across windows', () => {
  it('each window hears whether ANOTHER is speaking, only when it changes', () => {
    const h = harness()
    h.key.report(1, quiet)
    h.key.report(2, quiet)
    expect(h.to(1, 'updates:elsewhere')).toEqual([{ channel: 'updates:elsewhere', value: false }])
    h.key.report(1, reading)
    expect(h.to(2, 'updates:elsewhere').at(-1)).toEqual({
      channel: 'updates:elsewhere',
      value: true
    })
    // Window 1 is not told about itself.
    expect(h.to(1, 'updates:elsewhere')).toHaveLength(1)
    // The same again changes nothing.
    h.key.report(1, reading)
    expect(h.to(2, 'updates:elsewhere')).toHaveLength(2)
    // A line being said counts as speaking too.
    h.key.report(1, quiet)
    h.key.report(1, saying)
    expect(h.to(2, 'updates:elsewhere').map((m) => 'value' in m && m.value)).toEqual([
      false,
      true,
      false,
      true
    ])
  })
  it('a closed window no longer counts', () => {
    const h = harness()
    h.key.report(1, reading)
    h.key.report(2, quiet)
    expect(h.to(2, 'updates:elsewhere').at(-1)).toEqual({
      channel: 'updates:elsewhere',
      value: true
    })
    h.key.closed(1)
    expect(h.to(2, 'updates:elsewhere').at(-1)).toEqual({
      channel: 'updates:elsewhere',
      value: false
    })
  })
  it('a window that starts playing makes every other playing window yield', () => {
    const h = harness()
    h.key.report(1, reading)
    h.key.report(2, waiting(1))
    h.key.report(3, quiet)
    expect(h.sent.filter((s) => s.message.channel === 'updates:yield')).toEqual([])
    h.key.report(2, reading)
    expect(h.to(1, 'updates:yield')).toHaveLength(1)
    expect(h.to(3, 'updates:yield')).toHaveLength(0)
    expect(h.to(2, 'updates:yield')).toHaveLength(0)
    // Still playing: no second yield.
    h.key.report(2, reading)
    expect(h.to(1, 'updates:yield')).toHaveLength(1)
  })
})
