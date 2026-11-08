import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

import { WindowStateStore } from './window-state'

/**
 * windows.json — the windows to bring back at boot. A wrong entry here is
 * silent: a window simply does not come back, or comes back on the wrong
 * workspace, and the user blames themselves.
 */
let dir: string
let store: WindowStateStore

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-windows-'))
  store = new WindowStateStore(path.join(dir, 'windows.json'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('WindowStateStore', () => {
  it('lists nothing when the file is absent', () => {
    expect(store.list()).toEqual([])
  })

  it('upsert creates the file; a second store reads it back in order', () => {
    store.upsert('k1', { workspaceId: 'A' })
    store.upsert('k2', { workspaceId: null, bounds: { x: 1, y: 2, width: 300, height: 200 } })
    const again = new WindowStateStore(path.join(dir, 'windows.json'))
    expect(again.list()).toEqual([
      { key: 'k1', workspaceId: 'A' },
      { key: 'k2', workspaceId: null, bounds: { x: 1, y: 2, width: 300, height: 200 } }
    ])
  })

  it('upsert patches only the given fields', () => {
    store.upsert('k1', { workspaceId: 'A', bounds: { x: 0, y: 0, width: 800, height: 600 } })
    store.upsert('k1', { workspaceId: 'B' })
    expect(store.list()[0]).toEqual({
      key: 'k1',
      workspaceId: 'B',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    })
    store.upsert('k1', { bounds: { x: 5, y: 5, width: 900, height: 700 } })
    expect(store.list()[0].workspaceId).toBe('B')
    expect(store.list()[0].bounds).toEqual({ x: 5, y: 5, width: 900, height: 700 })
  })

  it('remove forgets exactly that window', () => {
    store.upsert('k1', { workspaceId: 'A' })
    store.upsert('k2', { workspaceId: 'A' })
    store.remove('k1')
    expect(store.keys()).toEqual(new Set(['k2']))
    expect(store.has('k1')).toBe(false)
    store.remove('never-there')
    expect(store.list().length).toBe(1)
  })

  it('drops malformed entries and bad bounds on read, keeps the good ones', () => {
    fs.writeFileSync(
      path.join(dir, 'windows.json'),
      JSON.stringify({
        version: 1,
        windows: [
          { key: 'ok', workspaceId: 'A', bounds: { x: 1, y: 1, width: 0, height: 10 } },
          { key: '../escape', workspaceId: 'A' },
          { workspaceId: 'A' },
          { key: 'ok', workspaceId: 'B' },
          'garbage'
        ]
      })
    )
    expect(store.list()).toEqual([{ key: 'ok', workspaceId: 'A' }])
  })

  it('an unreadable file lists nothing (the entry then treats it as a first boot)', () => {
    fs.writeFileSync(path.join(dir, 'windows.json'), '{not json')
    expect(store.list()).toEqual([])
  })

  it('mints distinct keys', () => {
    expect(store.mintKey()).not.toBe(store.mintKey())
  })
})
