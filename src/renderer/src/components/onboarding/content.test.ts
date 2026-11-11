import { describe, it, expect } from 'vitest'
import { CHAT_VIEWS, FIRST_MESSAGE, SETUP_LINE_HINT, folderPreview, folderTarget } from './content'

/**
 * The walk's words. Clave is public: nothing in them names a team, a server
 * or a company. The setup-line hint is a sentence other people's welcome
 * notes point at, so it is pinned word for word.
 */
describe('the first-run walk', () => {
  it('keeps the setup-line hint word for word', () => {
    expect(SETUP_LINE_HINT).toBe('If someone gave you a setup line, paste it here')
  })

  it('names no team, hub or company in what it sends or shows', () => {
    const words = [FIRST_MESSAGE, SETUP_LINE_HINT, ...CHAT_VIEWS.map((v) => v.tagline)].join(' ')
    expect(words).not.toMatch(/antasphere|team hub|steward|\bhub\b/i)
  })

  it('offers the three chat views by their plugin ids, then the terminal', () => {
    expect(CHAT_VIEWS.map((v) => v.id)).toEqual([
      'clave.chat-view/chat',
      'clave.chat-view/terminal',
      'clave.chat-view/lab',
      'terminal'
    ])
    expect(CHAT_VIEWS.map((v) => v.mode)).toEqual(['chat', 'enclave', 'folio', 'terminal'])
    expect(CHAT_VIEWS.map((v) => v.preview)).toEqual(['chat', 'enclave', 'lab', 'terminal'])
  })

  it('shows the folder to be made under ~ when it is under home', () => {
    expect(folderPreview('/Users/a', '/Users/a', 'My workspace')).toBe('~/My workspace')
    expect(folderPreview('/Users/a', '/Users/a/Code', 'x/y')).toBe('~/Code/x y')
    expect(folderPreview('/Users/a', '/Volumes/Work', '')).toBe('/Volumes/Work/…')
  })
})

describe('the folder the walk makes', () => {
  it('is the path main will create, so a clash is found before anything is made', () => {
    expect(folderTarget('/Users/a', 'My workspace')).toBe('/Users/a/My workspace')
    expect(folderTarget('/Users/a/', 'x/y:z')).toBe('/Users/a/x y z')
    expect(folderTarget('/Users/a', '  ')).toBeNull()
  })
})
