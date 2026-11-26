/**
 * Settings → Writing styles (PRDCT-5166): the page for one machine, drawn
 * from that machine's view as the store keeps it. A built-in style offers
 * no Edit and no Delete; the default select lists "No style" then every
 * style and writes to the machine the page names; the Claude Code section
 * shows only when there is an output style to import; the harness lines are
 * the table's; an older server shows the update it needs. The editor opens
 * read-only on a built-in, counts the characters near the limit, and offers
 * the status card's rule only when the card is on.
 *
 * Rendered to static markup; the select is a recorder, so a test drives its
 * `onChange` as a pick in the menu would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BUILT_IN_STYLES,
  WRITING_STYLE_LIMITS,
  WRITING_STYLES_NEED_UPDATE,
  type WritingStylesView
} from '../../../../shared/writing-styles'
import { HARNESSES } from '../../../../shared/harness'

const h = vi.hoisted(() => ({
  /** The store's machines as the page reads them (a static render reads a
   *  zustand store's initial state, never a later one). */
  byMachine: {} as Record<string, unknown>,
  selects: [] as {
    testId?: string
    value: string
    options: { value: string; label: string }[]
    onChange: (value: string) => void
  }[]
}))

vi.mock('../../store/writing-styles-store', async (original) => {
  const real = await original<typeof import('../../store/writing-styles-store')>()
  return {
    ...real,
    useWritingStylesStore: (select: (s: { byMachine: Record<string, unknown> }) => unknown) =>
      select({ byMachine: h.byMachine })
  }
})
vi.mock('./primitives', async (original) => {
  const real = await original<typeof import('./primitives')>()
  return {
    ...real,
    SettingsSelect: (props: (typeof h.selects)[number]) => {
      h.selects.push(props)
      return <div data-select={props.testId} data-value={props.value} />
    }
  }
})

const api = {
  fleetWritingStyles: vi.fn(async () => view()),
  fleetWritingStyleSetDefault: vi.fn(async () => view()),
  fleetWritingStyleSave: vi.fn(async () => view()),
  fleetWritingStyleDelete: vi.fn(async () => view()),
  fleetWritingStyleImportClaude: vi.fn(async () => view())
}
Object.assign(globalThis, { window: { electronAPI: api } })

import { WritingStyleEditor, WritingStylesList } from './WritingStylesSettings'

function view(over: Partial<WritingStylesView> = {}): WritingStylesView {
  return {
    styles: [
      ...BUILT_IN_STYLES,
      {
        id: 'plain',
        name: 'Plain',
        description: 'For quiet days.',
        text: 'Write plainly.',
        statusCard: false,
        builtIn: false
      }
    ],
    defaultStyleId: 'plain',
    claudeOutputStyle: null,
    ...over
  }
}

function render(machine: string, state: Partial<WritingStylesView> | { error: string }): string {
  h.selects = []
  h.byMachine = {
    [machine]:
      'error' in state
        ? { status: 'error', error: state.error, view: null }
        : { status: 'ready', error: null, view: view(state) }
  }
  return renderToStaticMarkup(<WritingStylesList machine={machine} machineName="Studio" />)
}

/** The markup of one style's row, up to the next row. */
function rowOf(html: string, id: string): string {
  const at = html.indexOf(`data-writing-style-row="${id}"`)
  expect(at, id).toBeGreaterThan(-1)
  const next = html.indexOf('data-writing-style-row=', at + 1)
  return html.slice(at, next < 0 ? undefined : next)
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear()
})

describe('the styles of the machine the page names', () => {
  it('offers View and Duplicate on a built-in, Edit, Duplicate and Delete on its own', () => {
    const html = render('server-b', {})
    for (const style of BUILT_IN_STYLES) {
      const row = rowOf(html, style.id)
      expect(row).toContain('Built-in')
      expect(row).toContain('Status card')
      expect(row).toContain(`data-testid="writing-style-view-${style.id}"`)
      expect(row).toContain(`data-testid="writing-style-duplicate-${style.id}"`)
      expect(row).not.toContain(`writing-style-edit-${style.id}`)
      expect(row).not.toContain(`writing-style-delete-${style.id}`)
    }
    const own = rowOf(html, 'plain')
    expect(own).toContain('For quiet days.')
    expect(own).not.toContain('Built-in')
    expect(own).not.toContain('Status card')
    for (const control of ['edit', 'duplicate', 'delete'])
      expect(own).toContain(`data-testid="writing-style-${control}-plain"`)
    expect(html).toContain('data-testid="writing-style-new"')
  })

  it('lists No style then every style as the default, and writes the pick to that machine', () => {
    render('server-b', {})
    const select = h.selects.find((s) => s.testId === 'writing-styles-default')
    expect(select?.value).toBe('plain')
    expect(select?.options).toEqual([
      { value: 'none', label: 'No style' },
      { value: 'brief', label: 'Brief' },
      { value: 'quiet', label: 'Quiet' },
      { value: 'plain', label: 'Plain' }
    ])
    select?.onChange('none')
    expect(api.fleetWritingStyleSetDefault).toHaveBeenCalledWith('server-b', null)
    select?.onChange('brief')
    expect(api.fleetWritingStyleSetDefault).toHaveBeenLastCalledWith('server-b', 'brief')
    render('server-b', { defaultStyleId: null })
    expect(h.selects.find((s) => s.testId === 'writing-styles-default')?.value).toBe('none')
  })

  it('shows the Claude Code section only when there is an output style to import', () => {
    expect(render('local', {})).not.toContain('writing-style-import-claude')
    const html = render('local', { claudeOutputStyle: { name: 'Field notes' } })
    expect(html).toContain('Output style « Field notes »')
    expect(html).toContain('data-testid="writing-style-import-claude"')
  })

  it('says what each harness takes, one line each, from the table', () => {
    const html = render('local', {})
    for (const harness of HARNESSES)
      expect(html).toContain(`data-writing-style-support="${harness.id}"`)
    expect(html).toContain('Claude Code: in its instructions, in a chat and in a terminal.')
    expect(html).toMatch(/with the first message in a chat; not taken in a terminal\./)
  })

  it('shows the update an older server needs, and nothing else', () => {
    const html = render('server-old', { error: WRITING_STYLES_NEED_UPDATE })
    expect(html).toContain(WRITING_STYLES_NEED_UPDATE)
    expect(html).not.toContain('data-writing-style-row')
  })
})

describe('the editor of one style', () => {
  const editor = (readOnly: boolean, text: string, statusCard: boolean): string =>
    renderToStaticMarkup(
      <WritingStyleEditor
        initial={{ id: 'brief', name: 'Brief', description: 'Short.', text, statusCard }}
        readOnly={readOnly}
        onSave={async () => null}
        onDuplicate={() => {}}
        onCancel={() => {}}
      />
    )

  it('opens a built-in read-only, with Duplicate in place of Save', () => {
    const html = editor(true, 'Be short.', true)
    expect(html).toMatch(
      /data-testid="writing-style-name"[^>]*readOnly|readOnly[^>]*data-testid="writing-style-name"/i
    )
    expect(html).toContain('data-testid="writing-style-duplicate"')
    expect(html).not.toContain('writing-style-save')
    const own = editor(false, 'Be short.', true)
    expect(own).toContain('data-testid="writing-style-save"')
    expect(own).not.toMatch(/readOnly/i)
  })

  it('counts the characters only past 80% of the limit', () => {
    expect(editor(false, 'x'.repeat(100), false)).not.toContain('data-writing-style-count')
    const near = editor(false, 'x'.repeat(WRITING_STYLE_LIMITS.text * 0.8), false)
    expect(near).toContain(
      `${WRITING_STYLE_LIMITS.text * 0.8} of ${WRITING_STYLE_LIMITS.text} characters`
    )
  })

  it('offers what Clave adds only when the status card is on', () => {
    expect(editor(false, 'Be short.', false)).not.toContain('What Clave adds to the instructions')
    expect(editor(false, 'Be short.', true)).toContain('What Clave adds to the instructions')
  })
})
