import { describe, expect, it } from 'vitest'
import type { PluginRecord } from '../../../../../../../packages/host/src/plugins/plugin-store'
import {
  actionLabels,
  groupTarget,
  pluginActions,
  sessionTarget,
  workspaceTarget
} from './plugin-actions-model'

type Action = {
  id: string
  title: string
  icon: string
  targets: ('session' | 'group' | 'workspace')[]
  preview?: boolean
}

function record(
  id: string,
  declared: Action[],
  registered: string[],
  overrides: Partial<PluginRecord> = {}
): PluginRecord {
  return {
    id,
    enabled: true,
    status: 'active',
    manifest: { name: `${id} plugin`, contributes: { actions: declared } },
    actions: registered,
    panels: [],
    commands: [],
    toolbar: [],
    generation: 0,
    ...overrides
  } as unknown as PluginRecord
}

const deck: Action = {
  id: 'deck',
  title: 'Make a deck',
  icon: 'ChartBarIcon',
  targets: ['session', 'group'],
  preview: true
}
const stats: Action = {
  id: 'stats',
  title: 'Stats',
  icon: 'ChartPieIcon',
  targets: ['workspace', 'session']
}

describe('pluginActions', () => {
  it('returns the live actions of the kind, in record then manifest order', () => {
    const records = [record('a', [deck, stats], ['deck', 'stats']), record('b', [stats], ['stats'])]
    expect(pluginActions(records, 'session').map((e) => `${e.pluginId}:${e.id}`)).toEqual([
      'a:deck',
      'a:stats',
      'b:stats'
    ])
    expect(pluginActions(records, 'group').map((e) => `${e.pluginId}:${e.id}`)).toEqual(['a:deck'])
    expect(pluginActions(records, 'workspace').map((e) => `${e.pluginId}:${e.id}`)).toEqual([
      'a:stats',
      'b:stats'
    ])
  })

  it('resolves the entry from the manifest and the record', () => {
    const [entry, second] = pluginActions(
      [record('a', [deck, stats], ['deck', 'stats'])],
      'session'
    )
    expect(entry).toEqual({
      pluginId: 'a',
      pluginName: 'a plugin',
      id: 'deck',
      title: 'Make a deck',
      icon: 'ChartBarIcon',
      targets: ['session', 'group'],
      preview: true
    })
    expect(second.preview).toBe(false)
  })

  it('skips a plugin that is disabled, not active or has no manifest', () => {
    const records = [
      record('off', [deck], ['deck'], { enabled: false }),
      record('starting', [deck], ['deck'], { status: 'starting' }),
      record('error', [deck], ['deck'], { status: 'error' }),
      record('bare', [deck], ['deck'], { manifest: undefined })
    ]
    expect(pluginActions(records, 'session')).toEqual([])
  })

  it('skips an action declared but not registered, or registered but not declared', () => {
    const records = [record('a', [deck], []), record('b', [], ['deck'])]
    expect(pluginActions(records, 'session')).toEqual([])
  })
})

describe('actionLabels', () => {
  it('uses the title, and adds the plugin name when two titles collide', () => {
    const entries = pluginActions(
      [record('a', [deck, stats], ['deck', 'stats']), record('b', [stats], ['stats'])],
      'session'
    )
    const labels = actionLabels(entries)
    expect(labels.get('a:deck')).toBe('Make a deck')
    expect(labels.get('a:stats')).toBe('Stats · a plugin')
    expect(labels.get('b:stats')).toBe('Stats · b plugin')
  })
})

describe('targets', () => {
  it('builds the workspace target, `none` when no workspace is open', () => {
    expect(workspaceTarget('w1')).toEqual({ kind: 'workspace', id: 'w1', workspaceId: 'w1' })
    expect(workspaceTarget(null)).toEqual({ kind: 'workspace', id: 'none', workspaceId: null })
  })

  it('builds the session and group targets', () => {
    expect(sessionTarget('s1', 'w1')).toEqual({ kind: 'session', id: 's1', workspaceId: 'w1' })
    expect(groupTarget('g1', null)).toEqual({ kind: 'group', id: 'g1', workspaceId: null })
  })
})
