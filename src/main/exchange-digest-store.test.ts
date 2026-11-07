import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DigestStore } from './exchange-digest-store'
import type { DigestDone } from '../shared/exchange-digest'

const digest = (summary: string): DigestDone => ({
  ok: true as const,
  needsYou: false,
  summary,
  message: null
})

describe('DigestStore', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digests-'))
    file = path.join(dir, 'exchange-digests.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('files a digest by session and key, and finds it again after a restart', () => {
    const store = new DigestStore(file)
    store.put('tab-1', 'k1', digest('one'))
    store.put('tab-2', 'k1', digest('other tab'))
    store.flush()
    const reopened = new DigestStore(file)
    expect(reopened.get('tab-1', 'k1')?.summary).toBe('one')
    expect(reopened.get('tab-2', 'k1')?.summary).toBe('other tab')
    expect(reopened.of('tab-1')).toEqual({ k1: digest('one') })
    expect(reopened.get('tab-1', 'missing')).toBeUndefined()
  })

  it('writes through a temporary file, leaving none behind', () => {
    const store = new DigestStore(file)
    store.put('tab', 'k', digest('x'))
    store.flush()
    expect(fs.readdirSync(dir)).toEqual(['exchange-digests.json'])
  })

  it('sets an unreadable file aside and starts empty', () => {
    fs.writeFileSync(file, '{ not json')
    const store = new DigestStore(file)
    expect(store.of('tab')).toEqual({})
    store.put('tab', 'k', digest('fresh'))
    store.flush()
    expect(new DigestStore(file).get('tab', 'k')?.summary).toBe('fresh')
    expect(fs.readdirSync(dir).some((name) => name.includes('.unreadable-'))).toBe(true)
  })

  it('keeps a session to its latest forty digests', () => {
    const store = new DigestStore(file)
    for (let i = 0; i < 45; i++) store.put('tab', `k${i}`, digest(String(i)))
    const kept = Object.keys(store.of('tab'))
    expect(kept).toHaveLength(40)
    expect(store.get('tab', 'k44')).toBeDefined()
  })
})
