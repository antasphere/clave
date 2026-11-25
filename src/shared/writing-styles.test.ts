import { describe, expect, it } from 'vitest'
import { HARNESSES } from './harness'
import { STATUS_CARD_RULE, readStatusCard } from './status-card'
import {
  BUILT_IN_STYLES,
  NO_STYLE,
  STYLE_SUPPORT,
  WRITING_STYLE_LIMITS,
  checkStyleDraft,
  composeStyleText,
  findStyle,
  isReservedStyleId,
  styleAsFirstMessage,
  styleIdFor
} from './writing-styles'

describe('the built-in styles', () => {
  it('are valid styles under ids no other style may take', () => {
    expect(BUILT_IN_STYLES.map((style) => style.id)).toEqual(['brief', 'quiet'])
    for (const style of BUILT_IN_STYLES) {
      expect(style.builtIn).toBe(true)
      expect(isReservedStyleId(style.id)).toBe(true)
      expect(checkStyleDraft(style)).toMatchObject({ ok: true })
    }
    expect(isReservedStyleId(NO_STYLE)).toBe(true)
    expect(isReservedStyleId('mine')).toBe(false)
  })
})

describe('composeStyleText', () => {
  it('is the text alone for a style without the card', () => {
    expect(composeStyleText({ text: '  Be short.  ', statusCard: false })).toBe('Be short.')
  })

  it("adds the card's rule after the text, and stands alone on an empty text", () => {
    expect(composeStyleText({ text: 'Be short.', statusCard: true })).toBe(
      `Be short.\n\n${STATUS_CARD_RULE}`
    )
    expect(composeStyleText({ text: ' ', statusCard: true })).toBe(STATUS_CARD_RULE)
    expect(composeStyleText({ text: ' ', statusCard: false })).toBe('')
  })

  it("leaves no status block at the end of what the agent is given, the rule's example aside", () => {
    // The rule ends on prose: an agent that echoed its instructions would not
    // be read as having written a card.
    for (const style of BUILT_IN_STYLES)
      expect(readStatusCard(composeStyleText(style)).card).toBeNull()
  })
})

describe('STYLE_SUPPORT', () => {
  it('says something for every harness Clave launches, in both kinds of tab', () => {
    for (const harness of HARNESSES) {
      const support = STYLE_SUPPORT[harness.id]
      expect(support, harness.id).toBeDefined()
      expect(['instructions', 'first-message', 'none']).toContain(support.terminal)
      expect(['instructions', 'first-message', 'none']).toContain(support.chat)
    }
    expect(Object.keys(STYLE_SUPPORT).sort()).toEqual(HARNESSES.map((h) => h.id).sort())
  })

  it('never promises a chat-only road to a terminal tab', () => {
    for (const harness of HARNESSES)
      expect(STYLE_SUPPORT[harness.id].terminal, harness.id).not.toBe('first-message')
  })
})

describe('styleAsFirstMessage', () => {
  it('carries the style, then the message as the person wrote it, last', () => {
    const sent = styleAsFirstMessage('Be short.', 'Fix the test\nplease')
    expect(sent).toContain('Be short.')
    expect(sent.endsWith('Fix the test\nplease')).toBe(true)
    expect(sent.indexOf('Be short.')).toBeLessThan(sent.indexOf('Fix the test'))
  })
})

describe('styleIdFor', () => {
  it("is the name's slug, numbered when another style has it", () => {
    expect(styleIdFor('Dense', new Set())).toBe('dense')
    expect(styleIdFor('  Très court ! ', new Set())).toBe('tres-court')
    expect(styleIdFor('Dense', new Set(['dense']))).toBe('dense-2')
    expect(styleIdFor('Dense', new Set(['dense', 'dense-2']))).toBe('dense-3')
  })

  it('never takes a reserved id, and names a style with no letters', () => {
    expect(styleIdFor('Brief', new Set())).toBe('brief-2')
    expect(styleIdFor('!!!', new Set())).toBe('style')
  })
})

describe('checkStyleDraft', () => {
  const draft = {
    name: 'Dense',
    description: 'Short answers.',
    text: 'Be short.',
    statusCard: true
  }

  it('trims a draft and keeps the id it names', () => {
    expect(
      checkStyleDraft({ ...draft, id: 'dense', name: ' Dense ', text: 'Be short.\n' })
    ).toEqual({
      ok: true,
      draft: { ...draft, id: 'dense' }
    })
    expect(checkStyleDraft(draft)).toEqual({ ok: true, draft })
  })

  it('refuses what cannot be a style, with a sentence for the person', () => {
    const refused = (raw: unknown): string => {
      const check = checkStyleDraft(raw)
      if (check.ok) throw new Error('accepted')
      return check.reason
    }
    expect(refused(null)).toMatch(/not valid/)
    expect(refused({ ...draft, name: ' ' })).toMatch(/needs a name/)
    expect(refused({ ...draft, name: 'None' })).toMatch(/no style/)
    expect(refused({ ...draft, name: 'a'.repeat(WRITING_STYLE_LIMITS.name + 1) })).toMatch(/name/)
    expect(
      refused({ ...draft, description: 'a'.repeat(WRITING_STYLE_LIMITS.description + 1) })
    ).toMatch(/description/)
    expect(refused({ ...draft, text: 'a'.repeat(WRITING_STYLE_LIMITS.text + 1) })).toMatch(
      /instructions/
    )
    expect(refused({ ...draft, text: '', statusCard: false })).toMatch(/needs instructions/)
  })

  it('takes the card alone as a style', () => {
    expect(checkStyleDraft({ ...draft, text: '' })).toMatchObject({ ok: true })
  })
})

describe('findStyle', () => {
  const mine = { ...BUILT_IN_STYLES[0], id: 'dense', name: 'Dense', builtIn: false }
  const styles = [...BUILT_IN_STYLES, mine]

  it('finds a style by its id, or by its name in any case', () => {
    expect(findStyle(styles, 'quiet')).toBe(BUILT_IN_STYLES[1])
    expect(findStyle(styles, ' DENSE ')).toBe(mine)
    expect(findStyle(styles, 'Brief')).toBe(BUILT_IN_STYLES[0])
  })

  it('reads the word for no style, and says when a style is unknown', () => {
    expect(findStyle(styles, 'none')).toBe(NO_STYLE)
    expect(findStyle(styles, 'None')).toBe(NO_STYLE)
    expect(findStyle(styles, 'verbose')).toBeNull()
    expect(findStyle(styles, ' ')).toBeNull()
  })
})
