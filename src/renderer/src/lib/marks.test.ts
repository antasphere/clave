import { describe, expect, it } from 'vitest'
import { availableMarks, resolveMark, LOGO_MARK } from './marks'
import type { PluginRecord } from '../../../main/plugins/plugin-store'

const plugin = (over: Partial<PluginRecord> = {}): PluginRecord =>
  ({
    id: 'clave.orbs',
    version: '1.0.0',
    source: 'bundled',
    enabled: true,
    permissionsGranted: [],
    installedAt: '2026-10-11T00:00:00.000Z',
    directory: '/bundled/orbs',
    status: 'active',
    panels: [],
    commands: [],
    toolbar: [],
    generation: 1,
    manifest: {
      id: 'clave.orbs',
      name: 'Thinking orbs',
      version: '1.0.0',
      kind: 'plugin',
      engines: { clave: '>=2.2.0' },
      ui: 'native',
      uiEntry: undefined,
      contributes: {
        panels: [],
        commands: [],
        toolbar: [],
        views: [],
        adapters: [],
        marks: [{ id: 'orbs', title: 'Orb', slots: ['agent', 'tool'] }]
      },
      permissions: []
    },
    ...over
  }) as PluginRecord

const IMPLEMENTED = new Set(['clave.orbs/orbs'])

describe('availableMarks', () => {
  it('lists a bundled, enabled, native plugin’s packs this build carries', () => {
    expect(availableMarks([plugin()], IMPLEMENTED)).toEqual([
      { id: 'clave.orbs/orbs', title: 'Orb', pluginName: 'Thinking orbs', slots: ['agent', 'tool'] }
    ])
  })
  it('lists a pack while its plugin is still starting (every plugin restarts on a reload)', () => {
    expect(availableMarks([plugin({ status: 'starting' })], IMPLEMENTED)).toHaveLength(1)
  })
  it('offers nothing from a disabled, failed, linked or surface plugin', () => {
    expect(availableMarks([plugin({ enabled: false })], IMPLEMENTED)).toEqual([])
    expect(availableMarks([plugin({ status: 'error' })], IMPLEMENTED)).toEqual([])
    expect(availableMarks([plugin({ error: 'crashed' })], IMPLEMENTED)).toEqual([])
    expect(availableMarks([plugin({ source: 'link' })], IMPLEMENTED)).toEqual([])
    const surface = plugin()
    surface.manifest = { ...surface.manifest!, ui: 'surface' }
    expect(availableMarks([surface], IMPLEMENTED)).toEqual([])
  })
  it('never offers a pack the build has no component for', () => {
    expect(availableMarks([plugin()], new Set())).toEqual([])
  })
})

describe('resolveMark', () => {
  const available = availableMarks([plugin()], IMPLEMENTED)
  it('keeps a saved pack that can be drawn', () => {
    expect(resolveMark('clave.orbs/orbs', available)).toBe('clave.orbs/orbs')
  })
  it('falls back to the logo for nothing saved, the logo, or a pack that is gone', () => {
    expect(resolveMark(null, available)).toBe(LOGO_MARK)
    expect(resolveMark('logo', available)).toBe(LOGO_MARK)
    expect(resolveMark('clave.orbs/orbs', [])).toBe(LOGO_MARK)
    expect(resolveMark('someone.else/pack', available)).toBe(LOGO_MARK)
  })
})
