import { describe, expect, it } from 'vitest'
import { pickGroupViewTerminal, resolveDeclaredGroupView } from './group-view'

const term = (
  o: Partial<{ id: string; groupView: boolean; serverUrl: string }> = {}
): {
  id: string
  groupView?: boolean
  serverUrl?: string
} => ({ id: 't', ...o })

describe('pickGroupViewTerminal', () => {
  it('picks the terminal that declares the view and serves it', () => {
    const wanted = term({ id: 'board', groupView: true, serverUrl: 'http://127.0.0.1:4713' })
    expect(pickGroupViewTerminal([term({ id: 'dev' }), wanted])).toBe(wanted)
  })

  it('ignores a declaration with no serverUrl — a view needs a page', () => {
    expect(pickGroupViewTerminal([term({ id: 'board', groupView: true })])).toBeUndefined()
  })

  it('ignores a serverUrl that never asked to be the view', () => {
    expect(
      pickGroupViewTerminal([term({ id: 'docs', serverUrl: 'http://localhost:4711' })])
    ).toBeUndefined()
  })

  it('ignores a serverUrl that is not an http(s) URL', () => {
    expect(
      pickGroupViewTerminal([term({ id: 'board', groupView: true, serverUrl: 'localhost:4713' })])
    ).toBeUndefined()
    expect(
      pickGroupViewTerminal([term({ id: 'board', groupView: true, serverUrl: '/tmp/page.html' })])
    ).toBeUndefined()
  })

  it('takes the first when a file declares two', () => {
    const first = term({ id: 'a', groupView: true, serverUrl: 'http://127.0.0.1:1' })
    const second = term({ id: 'b', groupView: true, serverUrl: 'http://127.0.0.1:2' })
    expect(pickGroupViewTerminal([first, second])).toBe(first)
  })

  it('is inert for a group with no terminals', () => {
    expect(pickGroupViewTerminal([])).toBeUndefined()
  })
})

describe('resolveDeclaredGroupView', () => {
  const served = term({ id: 'board', groupView: true, serverUrl: 'http://127.0.0.1:4713' })

  it('takes a group-level file view when no terminal serves one', () => {
    expect(
      resolveDeclaredGroupView([term({ id: 'dev' })], '/repo/snapshots/board.html', 'Syndicable')
    ).toEqual({
      url: '/repo/snapshots/board.html',
      title: 'Syndicable',
      terminalId: null
    })
  })

  it('takes a group-level http view too', () => {
    expect(resolveDeclaredGroupView([], 'https://status.example.com')?.url).toBe(
      'https://status.example.com'
    )
  })

  it('lets a serving terminal win — the live page carries the start action', () => {
    expect(resolveDeclaredGroupView([served], '/repo/snapshots/board.html')).toEqual({
      url: 'http://127.0.0.1:4713',
      title: undefined,
      terminalId: 'board'
    })
  })

  it('ignores a view that is neither a URL nor an .html file', () => {
    expect(resolveDeclaredGroupView([], '/repo/README.md')).toBeUndefined()
    expect(resolveDeclaredGroupView([], './relative/page.html')).toBeUndefined()
    expect(resolveDeclaredGroupView([], '')).toBeUndefined()
  })

  it('is undefined when the group declares nothing', () => {
    expect(resolveDeclaredGroupView([term({ id: 'dev' })], null)).toBeUndefined()
  })
})
