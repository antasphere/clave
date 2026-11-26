import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the integrations document imported electron')
})

import { electronTestPorts } from '../ports/testing'
import {
  INTEGRATIONS_FILE,
  readIntegrationEntry,
  serialIntegrations,
  writeIntegrationEntry
} from './document'
import { ElevenLabsIntegration } from './elevenlabs'
import { JevIntegration } from './jev'

// One `integrations.json`, two stores (PRDCT-5179): each writes its own entry
// and nothing else, so the ElevenLabs key never erases the Jev key, nor the
// other way round, nor a key some later version wrote. `fetch` is stubbed:
// every call answers 200 with an empty object.

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 }))
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const BASE = 'http://stub.test'
const read = (dir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, INTEGRATIONS_FILE), 'utf-8')) as Record<string, unknown>

describe('the integrations document', () => {
  it('an ElevenLabs write keeps the jev entry and an unknown key', async () => {
    const ports = electronTestPorts()
    const jev = { sealed: 'jev-handle', setAt: 5, checkedAt: null, lastError: null }
    fs.writeFileSync(
      path.join(ports.dir, INTEGRATIONS_FILE),
      JSON.stringify({ version: 1, jev, later: { kept: true } })
    )
    await new ElevenLabsIntegration(ports, { baseUrl: () => BASE }).setKey('xi-unit-test-key-0001')
    const document = read(ports.dir)
    expect(document.jev).toEqual(jev)
    expect(document.later).toEqual({ kept: true })
    expect(document.elevenLabs).toMatchObject({ setAt: expect.any(Number) })
    expect(document.version).toBe(1)
  })

  it('a Jev write keeps the elevenLabs entry and an unknown key', async () => {
    const ports = electronTestPorts()
    const elevenLabs = { sealed: 'xi-handle', setAt: 5, voiceId: 'v1', modelId: 'eleven_v3' }
    fs.writeFileSync(
      path.join(ports.dir, INTEGRATIONS_FILE),
      JSON.stringify({ version: 1, elevenLabs, later: [1, 2] })
    )
    const jev = new JevIntegration(ports, { baseUrl: () => BASE })
    await jev.setKey('ts-unit-test-key-0001')
    expect(read(ports.dir)).toMatchObject({ version: 1, elevenLabs, later: [1, 2] })
    await jev.removeKey()
    expect(read(ports.dir)).toEqual({ version: 1, elevenLabs, later: [1, 2] })
  })

  it('two interleaved writes both land', async () => {
    const ports = electronTestPorts()
    const eleven = new ElevenLabsIntegration(ports, { baseUrl: () => BASE })
    const jev = new JevIntegration(ports, { baseUrl: () => BASE })
    await Promise.all([eleven.setKey('xi-unit-test-key-0001'), jev.setKey('ts-unit-test-key-0001')])
    expect(eleven.status().configured).toBe(true)
    expect(jev.status().configured).toBe(true)
    expect(await eleven.openKey()).toBe('xi-unit-test-key-0001')
    expect(await jev.openKey()).toBe('ts-unit-test-key-0001')
  })

  it('a write waits for the one before it, even one that failed', async () => {
    const order: string[] = []
    let release!: () => void
    const first = serialIntegrations(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('first')
            resolve()
          }
        })
    )
    const failing = serialIntegrations(() => {
      order.push('failing')
      throw new Error('boom')
    })
    const third = serialIntegrations(() => order.push('third'))
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await first
    await expect(failing).rejects.toThrow('boom')
    await third
    expect(order).toEqual(['first', 'failing', 'third'])
  })

  it('reads one entry; writing undefined deletes it; a broken file reads as empty', () => {
    const ports = electronTestPorts()
    expect(readIntegrationEntry(ports, 'jev')).toBeUndefined()
    writeIntegrationEntry(ports, 'jev', { a: 1 })
    writeIntegrationEntry(ports, 'other', 'x')
    expect(readIntegrationEntry(ports, 'jev')).toEqual({ a: 1 })
    writeIntegrationEntry(ports, 'jev', undefined)
    expect(read(ports.dir)).toEqual({ version: 1, other: 'x' })
    fs.writeFileSync(path.join(ports.dir, INTEGRATIONS_FILE), '{"version":1,"jev":{')
    expect(readIntegrationEntry(ports, 'jev')).toBeUndefined()
  })
})
