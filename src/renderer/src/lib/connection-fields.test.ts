// Lane C of the harness wave (PRDCT-4496): the stored connection a Pi or OpenCode tab runs on
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectionSessionFields } from './connection-fields'

describe('a clone carries the stored connection of its source (PRDCT-4496)', () => {
  it('carries the id and the label of a Pi tab and of an OpenCode tab', () => {
    const pair = { connectionId: 'conn-7', connectionLabel: 'Team DeepSeek' }
    expect(connectionSessionFields({ piMode: true, ...pair })).toEqual(pair)
    expect(connectionSessionFields({ opencodeMode: true, ...pair })).toEqual(pair)
  })

  it('carries nothing for a tab with no connection, or of another harness', () => {
    expect(connectionSessionFields({ piMode: true })).toEqual({})
    expect(
      connectionSessionFields({ connectionId: 'conn-7', connectionLabel: 'Team DeepSeek' })
    ).toEqual({})
  })

  // The sidebar's Duplicate is a callback inside a component no unit test
  // mounts: this pins that both its spawn options and the tab it adds take
  // the pair from the source session.
  it("is spread into both the Duplicate's spawn options and the tab it adds", () => {
    const source = readFileSync(
      join(__dirname, '..', 'components', 'layout', 'Sidebar.tsx'),
      'utf8'
    )
    const duplicate = source.slice(
      source.indexOf('const sessionInfo = await window.electronAPI.fleetStart('),
      source.indexOf("console.error('Failed to duplicate session:'")
    )
    expect(duplicate.length).toBeGreaterThan(0)
    expect(duplicate.match(/\.\.\.connectionSessionFields\(session\)/g)).toHaveLength(2)
  })

  it("is spread into both the sidebar Resume's spawn options and the tab it adds", () => {
    const source = readFileSync(
      join(__dirname, '..', 'components', 'layout', 'Sidebar.tsx'),
      'utf8'
    )
    const start = source.indexOf('const handleResumeSession = useCallback(')
    const resume = source.slice(start, source.indexOf("console.error('Failed to resume session:'"))
    expect(start).toBeGreaterThan(0)
    expect(resume.match(/\.\.\.connectionSessionFields\(session\)/g)).toHaveLength(2)
  })
})
