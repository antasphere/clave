import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The writing styles a machine keeps (PRDCT-5166): what a write puts in the
// document, what a read makes of a damaged one, and Claude Code's output
// style read off a home of the test's own.

vi.mock('electron', () => {
  throw new Error('the writing styles store imported electron')
})

import { fileStorage } from '../ports/storage'
import { tempDataDir } from '../ports/testing'
import type { SettingsPorts } from '../ports/registry'
import { BUILT_IN_STYLES, WRITING_STYLE_LIMITS } from '../../shared/writing-styles'
import { setWritingStylesSource, writingStylesView } from './source'
import { WRITING_STYLES_FILE, WritingStylesStore, installWritingStyles } from './store'

let dir: string
let home: string
let store: WritingStylesStore

const portsOn = (folder: string): SettingsPorts => ({
  storage: fileStorage(folder),
  secrets: {} as SettingsPorts['secrets']
})
const written = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, WRITING_STYLES_FILE), 'utf-8'))
const draft = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  description: `When ${name} fits.`,
  text: `Write as ${name}.`,
  statusCard: false,
  ...extra
})

beforeEach(() => {
  dir = tempDataDir('clave-writing-styles-')
  home = tempDataDir('clave-claude-home-')
  store = new WritingStylesStore(portsOn(dir), { claudeHome: () => home })
})

afterEach(() => {
  setWritingStylesSource(null)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

describe('WritingStylesStore', () => {
  it('is the built-in styles and no default on a machine with no document', () => {
    expect(store.view()).toEqual({
      styles: [...BUILT_IN_STYLES],
      defaultStyleId: null,
      claudeOutputStyle: null
    })
  })

  it('gives a new style its slug id and writes it after the built-in ones', () => {
    const view = store.save(draft('Plain Words'))
    expect(view.styles.map((style) => style.id)).toEqual([
      ...BUILT_IN_STYLES.map((style) => style.id),
      'plain-words'
    ])
    expect(view.styles.at(-1)).toMatchObject({ id: 'plain-words', builtIn: false })
    expect(written()).toEqual({
      version: 1,
      defaultStyleId: null,
      styles: [
        {
          id: 'plain-words',
          name: 'Plain Words',
          description: 'When Plain Words fits.',
          text: 'Write as Plain Words.',
          statusCard: false
        }
      ]
    })
  })

  it('refuses a second style of the same name, in any case, built-in included', () => {
    store.save(draft('Plain'))
    expect(() => store.save(draft('PLAIN'))).toThrow('Another style is already named "Plain".')
    expect(() => store.save(draft('brief'))).toThrow('Another style is already named "Brief".')
    expect((written().styles as unknown[]).length).toBe(1)
  })

  it('keeps the id of a style whose name is edited', () => {
    store.save(draft('Plain'))
    const view = store.save(draft('Very plain', { id: 'plain', statusCard: true }))
    const mine = view.styles.filter((style) => !style.builtIn)
    expect(mine).toEqual([
      {
        id: 'plain',
        name: 'Very plain',
        description: 'When Very plain fits.',
        text: 'Write as Very plain.',
        statusCard: true,
        builtIn: false
      }
    ])
  })

  it('refuses to save over or remove a built-in style, and an unknown id', () => {
    expect(() => store.save(draft('Mine', { id: 'brief' }))).toThrow(
      'The built-in styles cannot be changed: duplicate one to make your own.'
    )
    expect(() => store.save(draft('Mine', { id: 'gone' }))).toThrow(
      'This style no longer exists.'
    )
    expect(() => store.remove('quiet')).toThrow('The built-in styles cannot be deleted.')
    expect(() => store.remove('gone')).toThrow('This style no longer exists.')
    expect(fs.existsSync(path.join(dir, WRITING_STYLES_FILE))).toBe(false)
  })

  it("refuses a draft the seam's check refuses, with its sentence", () => {
    expect(() => store.save(draft('   '))).toThrow('A style needs a name.')
    expect(() => store.save(draft('Empty', { text: '', statusCard: false }))).toThrow(
      'A style needs instructions, or the status card.'
    )
  })

  it('sets and clears the default, and refuses an unknown one', () => {
    store.save(draft('Plain'))
    expect(store.setDefault('plain').defaultStyleId).toBe('plain')
    expect(written().defaultStyleId).toBe('plain')
    expect(store.setDefault('brief').defaultStyleId).toBe('brief')
    expect(store.setDefault('none').defaultStyleId).toBeNull()
    expect(store.setDefault('brief').defaultStyleId).toBe('brief')
    expect(store.setDefault(null).defaultStyleId).toBeNull()
    expect(() => store.setDefault('gone')).toThrow('This style no longer exists.')
  })

  it('clears the default when the default style is removed', () => {
    store.save(draft('Plain'))
    store.setDefault('plain')
    const view = store.remove('plain')
    expect(view.defaultStyleId).toBeNull()
    expect(view.styles.some((style) => style.id === 'plain')).toBe(false)
    expect(written()).toMatchObject({ defaultStyleId: null, styles: [] })
  })

  it('reads a default naming a style that no longer exists as none', () => {
    fs.writeFileSync(
      path.join(dir, WRITING_STYLES_FILE),
      JSON.stringify({ version: 1, defaultStyleId: 'deleted-by-hand', styles: [] })
    )
    expect(store.view().defaultStyleId).toBeNull()
  })

  it('refuses the 31st style of its own', () => {
    for (let n = 1; n <= WRITING_STYLE_LIMITS.styles; n++) store.save(draft(`Style ${n}`))
    expect(() => store.save(draft('One more'))).toThrow(/at most 30 styles/)
    expect((written().styles as unknown[]).length).toBe(WRITING_STYLE_LIMITS.styles)
  })

  it('reads a damaged document as far as it is well formed', () => {
    fs.writeFileSync(
      path.join(dir, WRITING_STYLES_FILE),
      JSON.stringify({
        version: 1,
        defaultStyleId: 'kept',
        styles: [
          { id: 'kept', name: 'Kept', description: '', text: 'Stay.', statusCard: false },
          'not a style',
          { id: 'brief', name: 'Over a built-in', text: 'No.', statusCard: false },
          { id: 'Bad Id', name: 'Bad id', text: 'No.', statusCard: false },
          { id: 'no-name', name: '', text: 'No.', statusCard: false },
          { id: 'twin', name: 'KEPT', text: 'No.', statusCard: false },
          { id: 'card', name: 'Card', text: 42, statusCard: true }
        ]
      })
    )
    const view = store.view()
    expect(view.styles.filter((style) => !style.builtIn)).toEqual([
      {
        id: 'kept',
        name: 'Kept',
        description: '',
        text: 'Stay.',
        statusCard: false,
        builtIn: false
      },
      { id: 'card', name: 'Card', description: '', text: '', statusCard: true, builtIn: false }
    ])
    expect(view.defaultStyleId).toBe('kept')
  })

  it('reads a document that is not JSON as none', () => {
    fs.writeFileSync(path.join(dir, WRITING_STYLES_FILE), '{"version": 1, "styl')
    expect(store.view().styles).toEqual([...BUILT_IN_STYLES])
    expect(store.save(draft('Plain')).styles.at(-1)?.id).toBe('plain')
  })

  it('is what a spawn reads once installed', () => {
    store.save(draft('Plain'))
    store.setDefault('plain')
    installWritingStyles(store)
    expect(writingStylesView().defaultStyleId).toBe('plain')
  })
})

describe("Claude Code's output style", () => {
  const setting = (outputStyle: unknown): void =>
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ outputStyle }))
  const styleFile = (file: string, content: string): void => {
    fs.mkdirSync(path.join(home, 'output-styles'), { recursive: true })
    fs.writeFileSync(path.join(home, 'output-styles', file), content)
  }

  it("names the person's file its setting names by the frontmatter's name, and imports it", () => {
    styleFile(
      'terse.md',
      [
        '---',
        'name: Field notes',
        'description: "Short notes, for a field day."',
        '---',
        '',
        'Write in field notes.',
        'One line each.',
        ''
      ].join('\n')
    )
    setting('field NOTES')
    expect(store.view().claudeOutputStyle).toEqual({ name: 'Field notes' })
    const view = store.importClaudeOutputStyle()
    expect(view.styles.at(-1)).toEqual({
      id: 'field-notes',
      name: 'Field notes',
      description: 'Short notes, for a field day.',
      text: 'Write in field notes.\nOne line each.',
      statusCard: false,
      builtIn: false
    })
    expect((written().styles as Array<{ text: string }>)[0].text).toBe(
      'Write in field notes.\nOne line each.'
    )
  })

  it("names a file with no frontmatter name by the file's base name", () => {
    styleFile('Teacher.md', 'Explain each step.\n')
    setting('teacher')
    expect(store.view().claudeOutputStyle).toEqual({ name: 'Teacher' })
    expect(store.importClaudeOutputStyle().styles.at(-1)).toMatchObject({
      name: 'Teacher',
      description: '',
      text: 'Explain each step.'
    })
  })

  it("is none for one of Claude Code's built-in styles, for default and with no setting", () => {
    styleFile('mine.md', '---\nname: Mine\n---\nMine.')
    setting('Explanatory')
    expect(store.view().claudeOutputStyle).toBeNull()
    setting('default')
    expect(store.view().claudeOutputStyle).toBeNull()
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    expect(store.view().claudeOutputStyle).toBeNull()
    fs.rmSync(path.join(home, 'settings.json'))
    expect(store.view().claudeOutputStyle).toBeNull()
    expect(() => store.importClaudeOutputStyle()).toThrow(
      'Claude Code has no output style of yours to import.'
    )
  })

  it('refuses a body over the limit, and clips a long description', () => {
    styleFile(
      'long.md',
      `---\nname: Long\ndescription: ${'d'.repeat(300)}\n---\n${'x'.repeat(WRITING_STYLE_LIMITS.text + 1)}`
    )
    setting('Long')
    expect(() => store.importClaudeOutputStyle()).toThrow(/over 6000 characters/)
    expect(fs.existsSync(path.join(dir, WRITING_STYLES_FILE))).toBe(false)
    styleFile('long.md', `---\nname: Long\ndescription: ${'d'.repeat(300)}\n---\nShort.`)
    expect(store.importClaudeOutputStyle().styles.at(-1)?.description).toBe(
      'd'.repeat(WRITING_STYLE_LIMITS.description)
    )
  })
})
