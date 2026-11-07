import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

const MONO_FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'

/**
 * Editor chrome — transparent so it inherits the panel surface. All colors are
 * CSS vars, so switching theme (dark / light / coffee) recolors the editor with
 * zero reconfiguration.
 */
const claveTheme = EditorView.theme({
  // Fill the (flex-column) container as a flex child rather than via height:100%.
  // The file panel is max-height-capped with no definite height, so height:100%
  // would not resolve and the editor would grow to its full content height —
  // overflowing the clipped container and killing vertical scrolling. Flex
  // sizing bounds the editor so .cm-scroller can scroll. See CodeEditor.tsx.
  '&': {
    color: 'var(--text-primary)',
    backgroundColor: 'transparent',
    fontSize: '12px',
    flex: '1 1 0%',
    minHeight: '0'
  },
  '.cm-content': {
    fontFamily: MONO_FONT,
    padding: '12px 0',
    caretColor: 'var(--accent)'
  },
  '.cm-scroller': {
    fontFamily: MONO_FONT,
    lineHeight: '1.6'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--cm-selection)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-tertiary)',
    border: 'none'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  '.cm-foldGutter': { display: 'none' }
})

const claveHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword],
    color: 'var(--cm-keyword)'
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta],
    color: 'var(--cm-comment)',
    fontStyle: 'italic'
  },
  {
    tag: [t.string, t.special(t.string), t.character, t.attributeValue],
    color: 'var(--cm-string)'
  },
  { tag: [t.regexp, t.escape], color: 'var(--cm-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--cm-number)' },
  { tag: [t.bool, t.null, t.atom, t.constant(t.variableName)], color: 'var(--cm-constant)' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName],
    color: 'var(--cm-function)'
  },
  { tag: [t.variableName, t.name, t.self], color: 'var(--cm-variable)' },
  { tag: [t.typeName, t.className, t.namespace, t.changed], color: 'var(--cm-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--cm-property)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--cm-tag)' },
  {
    tag: [
      t.operator,
      t.arithmeticOperator,
      t.logicOperator,
      t.bitwiseOperator,
      t.compareOperator,
      t.derefOperator
    ],
    color: 'var(--cm-operator)'
  },
  {
    tag: [t.punctuation, t.separator, t.bracket, t.squareBracket, t.paren, t.brace],
    color: 'var(--cm-punctuation)'
  },
  { tag: t.heading, color: 'var(--cm-keyword)', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: 'var(--cm-property)', textDecoration: 'underline' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--cm-keyword)' }
])

/** The full set of theming extensions to apply to a Clave code editor. */
export const claveEditorTheme: Extension = [claveTheme, syntaxHighlighting(claveHighlightStyle)]
